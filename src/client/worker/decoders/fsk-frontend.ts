/**
 * Shared NFM / 2-FSK bit-recovery front end for pager decoders.
 *
 * Extracted verbatim from the POCSAG decoder's signal path so GSC (and later
 * FLEX) reuse the same, proven bit recovery instead of duplicating it. It takes
 * FM-demodulated Float32 audio (the FM discriminator itself lives upstream in
 * the Rust/WASM DSP, shared by every NFM decoder) and emits one hard bit per
 * symbol via a callback. Everything above the bit stream — sync acquisition,
 * FEC, framing, charset — stays protocol-specific in each decoder.
 *
 * What it owns:
 *   - adaptive, unclamped DC removal (gain-independent slicing),
 *   - a zero-crossing timing PLL that centres sampling in each symbol,
 *   - the mid-symbol-crossing count (`nonconsec`) and PLL-lock flag that a
 *     decoder's sync logic reads to reject wrong-baud candidates.
 *
 * Bit convention matches POCSAG/GSC 2-FSK: mark ("1") = negative deviation, so
 * a sample below zero is bit 1.
 */
export class FskBitSlicer {
	/** Samples per bit = audioRate / baud. */
	readonly spb: number;
	private readonly onBit: (bit: number) => void;
	/** Optional dev tap: receives the soft (DC-removed) sample value used for
	 * each bit decision, plus the residual PLL phase at the decision instant
	 * (fractional overshoot past the ideal sample point, in bit units: 0 = dead
	 * on the bit centre, growing magnitude = the sample drifted off centre). A
	 * decoder logs both so a "why did a clean bit decode wrong" question is
	 * answered by measurement: |soft|≈0 is a marginal slice; a large |soft| with
	 * a large residual phase is a timing/boundary drift. The raw (pre-DC) demod
	 * sample is also reported: a value pinned near the discriminator's ±max while
	 * the bit still decodes wrong is a railed/clipped demod fault UPSTREAM of the
	 * slicer, distinct from a DC-tracker or slicer fault. Null = off, zero cost. */
	onSoftBit: ((soft: number, phase: number, raw: number) => void) | null = null;

	// ── DC removal ──
	private dcLevel = 0;
	/** Unclamped acquisition IIR with a 10 ms time constant. The estimate is
	 * held after sync so unbalanced payload runs cannot move the threshold. */
	private readonly dcAlpha: number;

	// ── PLL / timing ──
	/** PLL lock state (drives the timing gain). Read and set by the decoder's
	 * sync logic, so it is public. */
	pllLocked = false;
	private pllTimeout = 0;
	/** Mid-symbol crossings within the current symbol. High on a wrong-baud
	 * signal → a decoder uses it to block false sync acquisition. Public so the
	 * sync logic can read it. */
	nonconsec = 0;
	private lastSample = 0;

	// ── Integer phase accumulator + majority vote ──
	// The phase runs 0..phaseMax over one symbol; phaseRate advances it per
	// sample. The bit is decided by MAJORITY VOTE over the middle 80% of each
	// symbol (10% < phase < 90%), not a single centre sample — so one marginal
	// sample on a perfect signal cannot flip the bit (the other ~80% outvote it).
	private readonly phaseMax: number;
	private readonly phaseRate: number;
	private phase = 0;
	private voteHigh = 0;
	private voteLow = 0;

	// ── Envelope tracking (adaptive deviation reference) ──
	// The FM discriminator's output amplitude is not fixed: it rails on
	// strong/over-deviated signals and shrinks on weak ones. A running mean
	// of |sample| gives an adaptive reference so bit decisions are consistent
	// across the whole deviation range. While unlocked the envelope decays
	// slowly toward a neutral baseline instead of tracking noise.
	private env = 0.5;
	/** Neutral envelope baseline: the nominal 2-FSK symbol amplitude the demod
	 * produces at standard deviation (order 0.5 full-scale). The unlocked decay
	 * relaxes toward this, and it seeds the estimate before first lock. */
	private static readonly ENV_DEFAULT = 0.5;
	/** Envelope IIR coefficient (~64-bit time constant, like the old DC scale),
	 * slow enough to average over several codewords. */
	private readonly envAlpha: number;
	/** Unlocked decay coefficient: much slower than envAlpha, so between
	 * transmissions the envelope relaxes gently toward ENV_DEFAULT (over ~1000
	 * bit periods) instead of snapping or holding a stale value. */
	private readonly envDecayAlpha: number;

	constructor(audioRate: number, baud: number, onBit: (bit: number) => void) {
		this.spb = audioRate / baud;
		// 10 ms DC time constant: converges within the burst preamble regardless
		// of baud rate. A bit-scaled constant was too slow at low baud and left
		// the slicer DC-biased through short pages.
		this.dcAlpha = 1 / (audioRate * 0.01 + 1);
		// Envelope tracks slower than DC — it averages amplitude over ~64 bits.
		this.envAlpha = 1 / (64 * this.spb);
		// Unlocked decay ~1000 bits: reference relaxes gently between bursts.
		this.envDecayAlpha = 1 / (1024 * this.spb);
		// Integer phase scaling: phase runs 0..(100*audioRate) per symbol.
		this.phaseMax = 100 * audioRate;
		this.phaseRate = 100 * baud;
		this.onBit = onBit;
	}

	reset(): void {
		this.dcLevel = 0;
		this.pllLocked = false;
		this.pllTimeout = 0;
		this.nonconsec = 0;
		this.lastSample = 0;
		this.phase = 0;
		this.voteHigh = 0;
		this.voteLow = 0;
		this.env = FskBitSlicer.ENV_DEFAULT;
	}

	/**
	 * Re-anchor the bit clock to a just-verified symbol boundary. Call this
	 * when the decoder confirms a frame sync codeword: resets the phase
	 * accumulator to the start of a symbol and clears the in-progress vote.
	 * This pins the batch's codeword grid to the confirmed sync boundary so
	 * a timing slip during the previous batch cannot carry into the next one.
	 */
	syncPhase(): void {
		this.phase = 0;
		this.voteHigh = 0;
		this.voteLow = 0;
		this.pllLocked = true;
		this.pllTimeout = 0;
	}

	/**
	 * Adaptive DC removal. The FM discriminator has a fixed hardware DC offset
	 * that varies by tuner but is constant within a transmission. The IIR
	 * tracks and removes it during the alternating preamble, then freezes once
	 * locked so same-symbol codeword runs cannot drag the estimate toward the
	 * symbol level and bias the slicer.
	 */
	private removeDc(x: number): number {
		// Freeze the estimate while locked: the preamble's alternating pattern
		// gives unbiased estimates; data words are not balanced so updating
		// during decode would bias the slicer.
		if (!this.pllLocked) {
			this.dcLevel += this.dcAlpha * (x - this.dcLevel);
		}
		return x - this.dcLevel;
	}

	/** Feed a block of FM-demodulated samples; emits bits via the callback.
	 * Bit decisions use majority vote over the middle 80% of each symbol so
	 * a single marginal sample cannot flip a bit that the rest of the symbol
	 * supports correctly. */
	process(samples: Float32Array): void {
		const phaseMax = this.phaseMax;
		const lockedRate = 0.045;
		const unlockedRate = 0.05;

		for (let i = 0; i < samples.length; i++) {
			const val = this.removeDc(samples[i]);

			// Normalise by the running envelope so bit decisions are
			// consistent regardless of signal deviation. While unlocked the
			// envelope decays toward a neutral baseline rather than tracking
			// noise; sign is unchanged so acquisition is not affected.
			if (this.pllLocked) {
				this.env += this.envAlpha * (Math.abs(val) - this.env);
			} else {
				this.env += this.envDecayAlpha * (FskBitSlicer.ENV_DEFAULT - this.env);
			}
			const norm = this.env > 1e-6 ? val / this.env : val;
			const phasePercent = (100 * this.phase) / phaseMax;

			// Majority voting in the middle 80% of the symbol period (sign of the
			// envelope-normalised sample — identical sign to val, scale-free).
			if (phasePercent > 10 && phasePercent < 90) {
				if (norm > 0) this.voteHigh++;
				else this.voteLow++;
			}

			// Zero-crossing timing PLL on the envelope-normalised sample.
			// Proportional correction: a crossing in the first half (phase < 50%)
			// means we are late (positive error); in the second half, early.
			if (this.lastSample < 0 !== norm < 0) {
				const phaseError = phasePercent < 50 ? this.phase : this.phase - phaseMax;
				const rate = this.pllLocked ? lockedRate : unlockedRate;
				this.phase -= Math.trunc(phaseError * rate);
				// Mid-symbol-crossing classification: a crossing in the middle 80%
				// is near where a transition is expected (PLL tracking); outside
				// that range it is a symbol-centre crossing that a wrong-baud or
				// noisy signal produces. The decoder's sync logic reads nonconsec.
				if (phasePercent > 10 && phasePercent < 90) this.nonconsec++;
				else this.nonconsec = 0;
				this.pllTimeout = 0;
			}
			this.lastSample = norm;

			// Advance the phase accumulator.
			this.phase += this.phaseRate;

			// Symbol boundary: decide the bit by majority vote.
			if (this.phase >= phaseMax) {
				this.phase -= phaseMax;
				this.nonconsec = 0;
				// 2-FSK: mark ("1") = negative deviation (below zero).
				// Fall back to the last sample's sign when there were no votes.
				let bit: number;
				if (this.voteHigh + this.voteLow > 0) bit = this.voteLow >= this.voteHigh ? 1 : 0;
				else bit = val < 0 ? 1 : 0;
				// Representative soft value for the dev tap: the signed vote
				// margin scaled to the symbol, negative ⇒ bit 1 (same sign
				// convention as the single-sample slicer it replaces).
				const total = this.voteHigh + this.voteLow;
				const soft = total > 0 ? (this.voteHigh - this.voteLow) / total : val;
				this.onSoftBit?.(soft, this.phase / phaseMax, val);
				this.voteHigh = 0;
				this.voteLow = 0;
				if (++this.pllTimeout > 100) this.pllLocked = false;
				this.onBit(bit);
			}
		}
	}
}

/**
 * Rolling bit-error-rate accumulator over a decaying window of codewords,
 * extracted from POCSAG so GSC/FLEX report BER the same way. `add(errorBits,
 * payloadBits)` per decoded codeword; the window halves once it fills, giving
 * an exponentially-decaying recent average.
 */
export class BerWindow {
	private errBits = 0;
	private totalBits = 0;
	private codewords = 0;

	reset(): void {
		this.errBits = 0;
		this.totalBits = 0;
		this.codewords = 0;
	}

	add(errorBits: number, payloadBits: number): void {
		this.errBits += errorBits;
		this.totalBits += payloadBits;
		this.codewords++;
		if (this.codewords >= 64) {
			this.errBits *= 0.5;
			this.totalBits *= 0.5;
			this.codewords = 32;
		}
	}

	/** Bit-error rate 0..1, or null until any codeword is seen. */
	get ber(): number | null {
		return this.totalBits > 0 ? this.errBits / this.totalBits : null;
	}

	get count(): number {
		return this.codewords;
	}
}
