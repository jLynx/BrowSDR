/**
 * Frame-aware FLEX 2-FSK / 4-FSK front end for BrowSDR.
 *
 * Takes FM-demodulated Float32 audio (the discriminator lives upstream in
 * the shared Rust/WASM DSP) and recovers FLEX symbols, frames, and decoded
 * phase buffers.
 *
 * Unlike the free-running FskBitSlicer that POCSAG and GSC share, this front
 * end is frame-aware: FLEX changes symbol rate mid-frame (the S1 preamble is
 * always 1600 baud / 2FSK; data runs at 1600 or 3200 baud per the sync code),
 * and it slices four levels, not two. The slice envelope is measured on the
 * most recent known-symmetric S1 preamble and
 * HELD (frozen) through the data portion, because the 4FSK symbol distribution
 * is not DC-balanced over short intervals and continuous re-estimation would
 * shift the threshold and destroy the inner-level (bit_b) decision.
 *
 * Covers PLL symbol recovery, 4-level envelope-holding slicer, lock detection,
 * SYNC1 detection + mode selection (validates the sync via combined A/inv.A
 * BCH cross-correction), FIW decode, SYNC2, and data deinterleaving into the
 * four phase buffers.
 *
 * Symbol numbering (after polarity rectification):
 *   0 = -1 (outer negative), 1 = -1/3 (inner negative),
 *   2 = +1/3 (inner positive), 3 = +1 (outer positive).
 */

import { bchDecode, combinedACorrection, BCH_CLEAN } from './bch';
import { decodeFiw } from './fiw';
import type { FlexMode, FlexFrontendEvents, FlexFiw, FlexPhaseData } from './types';

// Dense demodulator diagnostics: per-symbol DC/envelope/PLL, lock/unlock,
// FIW results and state transitions. Gated on DEV so zero cost in prod.
const FLEX_DEMOD_DIAG = false;

// -- FLEX sync codes (frame.h FLEX_SYNC_Ax, the inverted upper-16 outer code) --
const FLEX_SYNC_A1 = 0x870c; // 1600bps/2FSK
const FLEX_SYNC_A2 = 0x7b18; // 3200bps/2FSK
const FLEX_SYNC_A3 = 0xb068; // 3200bps/4FSK (1600 baud)
const FLEX_SYNC_A4 = 0xdea0; // 6400bps/4FSK (3200 baud)
const FLEX_SYNC_MARKER = 0xa6c6aaaa; // 32-bit BBBBBBBB marker

// S2 correlation patterns (frame.h FLEX_S2_C / FLEX_S2_C_INV).
const FLEX_S2_C = 0xed84;
const FLEX_S2_C_INV = 0x127b;

// Frame geometry (frame.h).
const FLEX_WORDS_PER_FRAME = 88; // 11 blocks x 8 words
const FLEX_MAX_PHASES = 4; // A, B, C, D

// PLL tuning constants (empirically validated).
const SLICE_THRESHOLD = 0.667; // 4-level quantization at 2/3 envelope
const DC_OFFSET_FILTER = 0.01; // DC-removal IIR time constant (s) -- sync hunt (fast)
const DC_OFFSET_FILTER_DATA = 0.5; // DC-removal IIR time constant (s) -- FIW/S2 (slow)
const PHASE_LOCKED_RATE = 0.045; // PLL correction gain when locked
const PHASE_UNLOCKED_RATE = 0.05; // PLL correction gain when unlocked
const LOCK_LEN = 24; // symbols to check for the BS1 lock pattern
const DEMOD_TIMEOUT = 100; // max periods with no zero crossings
const IDLE_THRESHOLD = 0; // idle words tolerated before the data portion is declared ended

// RX state machine (SYNC1 -> FIW -> SYNC2 -> DATA); phase 1 drives SYNC1/FIW
// transitions and surfaces the others for later phases.
export const RX_STATE_SYNC1 = 0;
export const RX_STATE_FIW = 1;
export const RX_STATE_SYNC2 = 2;
export const RX_STATE_DATA = 3;

const MODES: FlexMode[] = [
	{ syncCode: FLEX_SYNC_A1, baud: 1600, levels: 2, label: 'A1 (1600bps/2FSK)' },
	{ syncCode: FLEX_SYNC_A3, baud: 1600, levels: 4, label: 'A3 (3200bps/4FSK)' },
	{ syncCode: FLEX_SYNC_A2, baud: 3200, levels: 2, label: 'A2 (3200bps/2FSK)' },
	{ syncCode: FLEX_SYNC_A4, baud: 3200, levels: 4, label: 'A4 (6400bps/4FSK)' },
];

// Non-functional-mode sync codes (ARIB STD-43A Table 3.2-5 / Section 3.2.1):
//
//   * Ar (0x34DF) is the Emergency Re-synchronization (ERS) code -- a VALID,
//     specified sync, not reserved. Per Section 3.2.1 the base station sends it
//     (BS + Ar + inv.BS + inv.Ar, like a sync "A" part but with NO FIW/S2/data)
//     as a continuous burst when it loses sync timing, before resuming paging.
//     The pager must react by RE-SYNCHRONIZING -- re-acquiring frame sync from
//     this signal -- otherwise "the pager will stop receiving". This receiver
//     reacts by reporting ERS and returning to S1 hunting, so it re-acquires on
//     the next real A1-A4 frame; the Ar burst carries no decodable frame.
//
//   * A5-A15 are Reserved (A7 may carry ReFLEX, unsupported here). They carry no
//     frame this receiver can decode, so they are only logged. To avoid false
//     positives, a reserved code is reported ONLY on a 100%-error-free match.
//
// The 16-bit values are the outer code (codehigh) from syncCheck, cross-checked
// against ARIB Table 3.2-5 and the transmitter sync arrays.
const SYNC_CODE_TABLE: Array<{ code: number; label: string; ers: boolean }> = [
	{ code: 0x34df, label: 'Ar (emergency re-sync)', ers: true },
	{ code: 0x22b4, label: 'A5 (reserved)', ers: false },
	{ code: 0xe9c4, label: 'A6 (reserved)', ers: false },
	{ code: 0x4c7c, label: 'A7 (reserved, may be ReFLEX)', ers: false },
	{ code: 0x9cbe, label: 'A8 (reserved)', ers: false },
	{ code: 0xe41d, label: 'A9 (reserved)', ers: false },
	{ code: 0xd379, label: 'A10 (reserved)', ers: false },
	{ code: 0x5a17, label: 'A11 (reserved)', ers: false },
	{ code: 0x6d73, label: 'A12 (reserved)', ers: false },
	{ code: 0x9167, label: 'A13 (reserved)', ers: false },
	{ code: 0x41a5, label: 'A14 (reserved)', ers: false },
	{ code: 0x0e62, label: 'A15 (reserved)', ers: false },
];

/**
 * Check a 64-bit sync shift register (as two 32-bit halves, hi:lo) for the
 * FLEX sync word AAAA:BBBBBBBB:CCCC where BBBBBBBB = marker and AAAA^CCCC =
 * 0xFFFF, allowing Hamming distance < 4 on both. Returns the 16-bit outer code
 * (AAAA), or 0. Operates on a 64-bit sliding window.
 */
function syncCheck(hi: number, lo: number): number {
	// marker = bits [47:16]; codehigh = bits [63:48]; codelow = ~bits[15:0].
	const marker = (((hi & 0xffff) << 16) | ((lo >>> 16) & 0xffff)) >>> 0;
	const codehigh = (hi >>> 16) & 0xffff;
	const codelow = ~lo & 0xffff;
	if (countBits32(marker ^ FLEX_SYNC_MARKER) < 4 && countBits32((codelow ^ codehigh) & 0xffff) < 4) {
		return codehigh;
	}
	return 0;
}

function countBits32(data: number): number {
	let d = data >>> 0;
	d = d - ((d >>> 1) & 0x55555555);
	d = (d & 0x33333333) + ((d >>> 2) & 0x33333333);
	d = (d + (d >>> 4)) & 0x0f0f0f0f;
	return ((d * 0x01010101) >>> 24) & 0xff;
}

/** Allocate a zeroed FLEX data-phase buffer (88 words). */
function makePhase(): FlexPhaseData {
	return {
		words: new Uint32Array(FLEX_WORDS_PER_FRAME),
		status: new Int8Array(FLEX_WORDS_PER_FRAME),
		lowConfBitA: new Uint32Array(FLEX_WORDS_PER_FRAME),
		lowConfBitB: new Uint32Array(FLEX_WORDS_PER_FRAME),
		altWords: new Uint32Array(FLEX_WORDS_PER_FRAME),
		receivedBits: new Uint8Array(FLEX_WORDS_PER_FRAME),
		altReceivedBits: new Uint8Array(FLEX_WORDS_PER_FRAME),
		idleCount: 0,
	};
}

export class FlexFrontend {
	private readonly sampleFreq: number;
	private readonly ev: FlexFrontendEvents;

	// -- PLL / timing --
	private baud = 1600; // S1 preamble is always 1600 baud
	private pllPhase = 0; // integer phase accumulator
	private pllLocked = false;
	private pllLastSample = 0;
	private pllNonconsec = 0;
	private pllTimeout = 0;
	private pllLockBuf = 0n; // 64-bit lock-pattern shift register (BigInt)

	// -- DC + envelope (held) --
	private pllZero = 0; // DC offset estimate
	private pllEnvelope = 0;
	private pllEnvelopeSum = 0;
	private pllEnvelopeCount = 0;
	private readonly envelopeWindow: Float64Array;
	private envelopePos = 0;

	// -- per-symbol vote accumulators --
	private readonly symCount = [0, 0, 0, 0];

	// -- RX state --
	private rxState = RX_STATE_SYNC1;
	private polarity = 0;
	private syncHi = 0; // high 32 bits of the raw sync shift register
	private syncLo = 0; // low 32 bits
	private syncACode = 0; // A code captured at sync-marker detection
	private s1TailCount = 0; // 0 = hunting, 1..16 = counting inv.A tail
	private mode: FlexMode | null = null;
	// ERS (Ar) is sent as a continuous burst (up to ~4 min). Latch so it is
	// reported ONCE per burst; re-armed when a real A1-A4 frame is acquired.
	private ersReported = false;

	// -- FIW (RX_STATE_FIW): 32-bit BCH codeword at 1600 baud --
	private fiwCount = 0;
	private fiwRaw = 0;
	private fiw: FlexFiw | null = null;

	// -- SYNC2 (RX_STATE_SYNC2): BS2 + C + inv.BS2 + inv.C at the data rate --
	private sync2Count = 0;
	private sync2Shiftreg = 0;
	private sync2CFound = 0;
	private sync2CPos = 0;
	private sync2CErrs = 0;
	private sync2CinvFound = 0;
	private sync2CinvPos = 0;
	private sync2CinvErrs = 0;
	private readonly sync2SymBuf = [0, 0, 0, 0];
	private sync2SymBufCount = 0;
	private sync2SymBufStart = 0;

	// -- DATA (RX_STATE_DATA): deinterleaved into four phase buffers --
	private dataCount = 0;
	private dataBitCounter = 0;
	private phaseToggle = 0;
	private readonly phases: FlexPhaseData[] = Array.from({ length: FLEX_MAX_PHASES }, makePhase);
	// Per-symbol confidence (bit_a/bit_b vote margin < 60%) for the current sym.
	private symBitALow = 0;
	private symBitBLow = 0;
	// Integrate-and-dump accumulator for the alternate (fallback) symbol.
	private pllIadSum = 0;
	private pllIadN = 0;
	private altSymbol = 1;
	private sync2AltSymBuf = new Uint8Array(4);

	constructor(sampleFreq: number, events: FlexFrontendEvents = {}) {
		this.sampleFreq = sampleFreq;
		this.ev = events;
		// One complete S1 (112 symbols): noise or previous frames cannot
		// dominate the level estimate when the next preamble is validated.
		this.envelopeWindow = new Float64Array(Math.ceil((sampleFreq * 112) / 1600));
	}

	reset(): void {
		this.baud = 1600;
		this.pllPhase = 0;
		this.pllLocked = false;
		this.pllLastSample = 0;
		this.pllNonconsec = 0;
		this.pllTimeout = 0;
		this.pllLockBuf = 0n;
		this.pllZero = 0;
		this.resetEnvelope();
		this.symCount[0] = this.symCount[1] = this.symCount[2] = this.symCount[3] = 0;
		this.rxState = RX_STATE_SYNC1;
		this.polarity = 0;
		this.syncHi = this.syncLo = 0;
		this.syncACode = 0;
		this.s1TailCount = 0;
		this.mode = null;
		this.ersReported = false;
		this.fiwCount = 0;
		this.fiwRaw = 0;
		this.fiw = null;
		this.resetSync2();
		this.clearPhaseData();
		this.pllIadSum = 0;
		this.pllIadN = 0;
	}

	private resetSync2(): void {
		this.sync2Count = 0;
		this.sync2Shiftreg = 0;
		this.sync2CFound = 0;
		this.sync2CPos = 0;
		this.sync2CErrs = 0;
		this.sync2CinvFound = 0;
		this.sync2CinvPos = 0;
		this.sync2CinvErrs = 0;
		this.sync2SymBufCount = 0;
		this.sync2SymBufStart = 0;
	}

	/** Zero all four phase buffers and the data bit counter. */
	private clearPhaseData(): void {
		for (const ph of this.phases) {
			ph.words.fill(0);
			ph.status.fill(0);
			ph.lowConfBitA.fill(0);
			ph.lowConfBitB.fill(0);
			ph.altWords.fill(0);
			ph.receivedBits!.fill(0);
			ph.altReceivedBits!.fill(0);
			ph.idleCount = 0;
		}
		this.phaseToggle = 0;
		this.dataBitCounter = 0;
	}

	private resetEnvelope(): void {
		this.pllEnvelope = 0;
		this.pllEnvelopeSum = 0;
		this.pllEnvelopeCount = 0;
		this.envelopePos = 0;
	}

	/** Feed a block of FM-demodulated samples. */
	process(samples: Float32Array): void {
		for (let i = 0; i < samples.length; i++) this.demodulate(samples[i]);
	}

	/**
	 * Cast one 4-level hard vote for the current (DC-removed) sample against the
	 * held slice threshold: below -thr = sym0, -thr..0 = sym1, 0..+thr = sym2,
	 * above +thr = sym3.
	 */
	private voteLevel(sample: number): void {
		const thr = this.pllEnvelope * SLICE_THRESHOLD;
		if (sample > 0) {
			if (sample > thr) this.symCount[3]++;
			else this.symCount[2]++;
		} else {
			if (sample < -thr) this.symCount[0]++;
			else this.symCount[1]++;
		}
	}

	/**
	 * PLL symbol timing recovery. Processes one sample; returns true at a symbol
	 * boundary.
	 */
	private buildSymbol(sampleIn: number): boolean {
		const phaseMax = 100 * this.sampleFreq;
		const phaseRate = (phaseMax * this.baud) / this.sampleFreq;
		const phasePercent = (100 * this.pllPhase) / phaseMax;

		// DC removal: fast while hunting in S1, slow in FIW/S2, frozen in DATA.
		if (this.rxState !== RX_STATE_DATA) {
			const dcTau = this.sampleFreq * (this.rxState === RX_STATE_SYNC1 ? DC_OFFSET_FILTER : DC_OFFSET_FILTER_DATA);
			this.pllZero = (this.pllZero * dcTau + sampleIn) / (dcTau + 1);
		}
		const sample = sampleIn - this.pllZero;

		if (this.pllLocked) {
			this.accumulateEnvelope(sample);
		} else {
			// Not locked: reset envelope and hold in S1 hunting.
			this.resetEnvelope();
			this.baud = 1600;
			this.pllTimeout = 0;
			this.pllNonconsec = 0;
			this.rxState = RX_STATE_SYNC1;
			this.s1TailCount = 0;
		}

		// Mid 10-90% of the symbol period: vote on the level (4-level slicer).
		if (phasePercent > 10 && phasePercent < 90) {
			this.voteLevel(sample);
			// Integrate-and-dump: tighter center 50% window feeds the alternate
			// symbol decision used as a BCH fallback during data decode.
			if (phasePercent > 25 && phasePercent < 75) {
				this.pllIadSum += sample;
				this.pllIadN++;
			}
		}

		// Zero-crossing -> PLL phase correction.
		if ((this.pllLastSample < 0 && sample >= 0) || (this.pllLastSample >= 0 && sample < 0)) {
			this.onZeroCrossing(phasePercent, phaseMax);
		}
		this.pllLastSample = sample;

		this.pllPhase += phaseRate;
		if (this.pllPhase > phaseMax) {
			this.pllPhase -= phaseMax;
			return true;
		}
		return false;
	}

	/** Estimate the envelope from the last S1-sized window, held outside S1. */
	private accumulateEnvelope(sample: number): void {
		if (this.rxState !== RX_STATE_SYNC1) return;
		if (this.pllEnvelopeCount === this.envelopeWindow.length) this.pllEnvelopeSum -= this.envelopeWindow[this.envelopePos];
		else this.pllEnvelopeCount++;
		const level = Math.abs(sample);
		this.envelopeWindow[this.envelopePos] = level;
		this.envelopePos = (this.envelopePos + 1) % this.envelopeWindow.length;
		this.pllEnvelopeSum += level;
		this.pllEnvelope = this.pllEnvelopeSum / this.pllEnvelopeCount;
	}

	/** Pull the PLL phase toward the symbol edge at a zero crossing. */
	private onZeroCrossing(phasePercent: number, phaseMax: number): void {
		const phaseError = phasePercent < 50 ? this.pllPhase : this.pllPhase - phaseMax;
		const rate = this.pllLocked ? PHASE_LOCKED_RATE : PHASE_UNLOCKED_RATE;
		this.pllPhase -= Math.trunc(phaseError * rate);

		// Too many mid-symbol crossings while locked -> lost lock.
		if (phasePercent > 10 && phasePercent < 90) {
			this.pllNonconsec++;
			if (this.pllNonconsec > 20 && this.pllLocked) this.setLocked(false);
		} else {
			this.pllNonconsec = 0;
		}
		this.pllTimeout = 0;
	}

	/** Main symbol demodulator: DC removal, envelope tracking, PLL, and 4-level slicer. */
	private demodulate(sampleIn: number): void {
		if (!this.buildSymbol(sampleIn)) return;

		this.pllNonconsec = 0;

		// Modal symbol = most-voted level this period.
		let decmax = 0;
		let modal = 0;
		for (let j = 0; j < 4; j++) {
			if (this.symCount[j] > decmax) {
				modal = j;
				decmax = this.symCount[j];
			}
		}

		// Per-bit margin confidence (DATA only), then clear the vote bins.
		this.computeConfidence();
		const dbgVotes = FLEX_DEMOD_DIAG ? [...this.symCount] : null;
		this.symCount[0] = this.symCount[1] = this.symCount[2] = this.symCount[3] = 0;

		// Integrate-and-dump alternate symbol over the center 50% window; feed
		// it into the alt phase buffers during data as a BCH fallback.
		const iadSymbol = this.integrateDumpSymbol();
		this.altSymbol = this.polarity ? 3 - iadSymbol : iadSymbol;
		if (this.pllLocked && this.rxState === RX_STATE_DATA) {
			this.readAltData(this.altSymbol);
		}

		if (this.pllLocked) {
			if (FLEX_DEMOD_DIAG)
				console.log(
					`[FLEX SYM] sym=${modal} iad=${iadSymbol} dc=${this.pllZero.toFixed(4)} env=${this.pllEnvelope.toFixed(4)} phase=${((100 * this.pllPhase) / (100 * this.sampleFreq)).toFixed(1)}% state=${this.rxState} votes=[${dbgVotes!.join(',')}]`,
				);
			this.feedSymbol(modal);
		} else {
			// Lock hunt: shift symbols in, match the BS1 alternating 0x6666...
			// pattern (sym 0->1, 3->2 via ^0x1, each a single set bit).
			this.pllLockBuf = ((this.pllLockBuf << 2n) | BigInt(modal ^ 0x1)) & ((1n << 64n) - 1n);
			const lockMask = (1n << BigInt(2 * LOCK_LEN)) - 1n;
			const lockPattern = this.pllLockBuf ^ 0x6666666666666666n;
			if ((lockPattern & lockMask) === 0n || (~lockPattern & lockMask) === 0n) {
				this.setLocked(true);
				this.pllLockBuf = 0n;
			}
		}

		// Timeout: no zero crossings for too long -> loss of signal.
		this.pllTimeout++;
		if (this.pllTimeout > DEMOD_TIMEOUT) {
			if (this.pllLocked) this.setLocked(false);
		}
	}

	private setLocked(locked: boolean): void {
		if (this.pllLocked === locked) return;
		// Preserve complete words collected before loss of signal or timing.
		// The per-word bit counts keep partial/missing words out of BCH decode.
		if (!locked && this.rxState === RX_STATE_DATA && this.dataCount > 0) this.endData();
		this.pllLocked = locked;
		if (!locked) this.ersReported = false; // re-arm: next ERS burst is reportable
		if (FLEX_DEMOD_DIAG)
			console.log(
				`[FLEX ${locked ? 'LOCK' : 'UNLOCK'}] dc=${this.pllZero.toFixed(4)} env=${this.pllEnvelope.toFixed(4)} baud=${this.baud} state=${this.rxState}`,
			);
		this.ev.onLock?.(locked);
	}

	/**
	 * Per-bit margin confidence (DATA only): a "close" vote means the winning
	 * side held < 60% of the total votes. bit_a splits pos/neg; bit_b splits
	 * outer/inner.
	 */
	private computeConfidence(): void {
		this.symBitALow = 0;
		this.symBitBLow = 0;
		if (this.rxState !== RX_STATE_DATA) return;
		const total = this.symCount[0] + this.symCount[1] + this.symCount[2] + this.symCount[3];
		if (total === 0) return;
		const bitaWin = Math.max(this.symCount[2] + this.symCount[3], this.symCount[0] + this.symCount[1]);
		const bitbWin = Math.max(this.symCount[0] + this.symCount[3], this.symCount[1] + this.symCount[2]);
		if (bitaWin * 10 < total * 6) this.symBitALow = 1;
		if (bitbWin * 10 < total * 6) this.symBitBLow = 1;
	}

	/** Threshold the center-50% integrate-and-dump mean to a 4-level symbol. */
	private integrateDumpSymbol(): number {
		let sym = 1;
		if (this.pllIadN > 0) {
			const mean = this.pllIadSum / this.pllIadN;
			const thr = this.pllEnvelope * SLICE_THRESHOLD;
			if (mean > 0) sym = mean > thr ? 3 : 2;
			else sym = mean < -thr ? 0 : 1;
		}
		this.pllIadSum = 0;
		this.pllIadN = 0;
		return sym;
	}

	/**
	 * Dispatch a recovered symbol to the RX state machine.
	 *
	 */
	private feedSymbol(sym: number): void {
		// Rectify for polarity (inverted mapping flips the level order).
		const symRect = this.polarity ? 3 - sym : sym;
		this.ev.onSymbol?.(symRect);

		switch (this.rxState) {
			case RX_STATE_SYNC1:
				this.handleSync1(sym);
				return;
			case RX_STATE_FIW:
				this.handleFiw(symRect);
				return;
			case RX_STATE_SYNC2:
				this.handleSync2(symRect);
				return;
			case RX_STATE_DATA:
				this.handleData(symRect);
				return;
		}
	}

	/**
	 * SYNC1 handling: accumulate raw (non-polarity-corrected) bits into the
	 * 64-bit sync register, detect the sync marker, then after 16 more symbols
	 * complete inv.A and validate via combined A/inv.A BCH correction. Port of
	 * the SYNC1 (preamble) state.
	 */
	private handleSync1(sym: number): void {
		const bit = sym < 2 ? 1 : 0;
		// Shift the 64-bit register left by one, feeding `bit` at the LSB.
		this.syncHi = (((this.syncHi << 1) | (this.syncLo >>> 31)) & 0xffffffff) >>> 0;
		this.syncLo = (((this.syncLo << 1) | bit) & 0xffffffff) >>> 0;

		if (this.s1TailCount === 0) {
			// Hunting for the sync marker (both polarities).
			let code = syncCheck(this.syncHi, this.syncLo);
			let polarity = 0;
			if (code === 0) {
				code = syncCheck(~this.syncHi >>> 0, ~this.syncLo >>> 0);
				polarity = 1;
			}
			// NOTE: osmocom uses a 128-bit register (hi:lo two uint64s); this is
			// a 64-bit one (syncHi:syncLo). That is sufficient ONLY because the A
			// code is snapshotted into syncACode *here*, at marker detection,
			// while A still occupies the high 32 bits. inv.A is read 16 shifts
			// later from the low 32 bits. Do not defer the A capture -- the
			// narrower register cannot hold A once the tail has shifted in.
			if (code !== 0 && this.decodeMode(code, polarity)) {
				if (FLEX_DEMOD_DIAG)
					console.log(
						`[FLEX SYNC_DETECT] code=0x${code.toString(16)} polarity=${polarity} dc=${this.pllZero.toFixed(4)} env=${this.pllEnvelope.toFixed(4)}`,
					);
				this.polarity = polarity;
				this.s1TailCount = 1;
			}
		} else if (++this.s1TailCount > 16) {
			// S1 complete: extract inv.A (now in syncLo), run combined correction.
			const invA = this.polarity ? this.syncLo : ~this.syncLo >>> 0;
			const corrected = combinedACorrection(this.syncACode, invA);
			if (corrected === 0) {
				if (FLEX_DEMOD_DIAG)
					console.log(`[FLEX SYNC_FAIL] combinedA=0 syncACode=0x${this.syncACode.toString(16)} invA=0x${invA.toString(16)}`);
				this.s1TailCount = 0; // false positive -> back to hunting
				return;
			}
			const finalSync = (~corrected >>> 16) & 0xffff;
			const mode = MODES.find((m) => m.syncCode === finalSync);
			if (!mode) {
				if (FLEX_DEMOD_DIAG)
					console.log(`[FLEX SYNC_NOMODE] finalSync=0x${finalSync.toString(16)} syncACode=0x${this.syncACode.toString(16)}`);
				this.reportNonModeSync(finalSync, this.syncACode, invA);
				this.s1TailCount = 0;
				return;
			}
			this.syncACode = corrected;
			this.mode = mode;
			this.ersReported = false; // real frame acquired -> re-arm ERS logging
			this.ev.onMode?.(mode, this.polarity);
			// FIW is always 1600 baud / 2FSK; the data rate (mode.baud) applies
			// only after a valid FIW. Keep 1600 until then.
			this.rxState = RX_STATE_FIW;
			this.baud = 1600;
			this.fiwCount = 0;
			this.fiwRaw = 0;
		}
	}

	/**
	 * RX_STATE_FIW: accumulate a 32-bit BCH codeword (1600/2FSK), then decode
	 * it. On success, switch to the data symbol rate and enter SYNC2; on
	 * failure, return to sync hunting.
	 */
	private handleFiw(symRect: number): void {
		this.fiwRaw = ((this.fiwRaw >>> 1) | (symRect > 1 ? 0x80000000 : 0)) >>> 0;
		if (++this.fiwCount !== 32) return;

		const fiw = decodeFiw(this.fiwRaw);
		if (!fiw) {
			if (FLEX_DEMOD_DIAG)
				console.log(
					`[FLEX FIW_FAIL] raw=0x${this.fiwRaw.toString(16).padStart(8, '0')} dc=${this.pllZero.toFixed(4)} env=${this.pllEnvelope.toFixed(4)}`,
				);
			this.rxState = RX_STATE_SYNC1;
			this.s1TailCount = 0;
			// FIW failed — genuine sync loss. Reset DC so the fast S1 time
			// constant re-acquires cleanly on the next preamble.
			this.pllZero = 0;
			this.resetEnvelope();
			return;
		}
		if (FLEX_DEMOD_DIAG)
			console.log(`[FLEX FIW_OK] cycle=${fiw.cycle} frame=${fiw.frame} roaming=${fiw.roaming} dc=${this.pllZero.toFixed(4)}`);
		this.fiw = fiw;
		this.ev.onFiw?.(fiw);
		// Switch to the data symbol rate; BS2 re-trains the PLL at the new rate.
		this.baud = this.mode ? this.mode.baud : 1600;
		this.resetSync2();
		this.rxState = RX_STATE_SYNC2;
	}

	/**
	 * RX_STATE_SYNC2: BS2 + C + inv.BS2 + inv.C at the data rate. The PLL is
	 * already synced from S1/FIW; S2 only re-trains across the baud switch and
	 * confirms the frame-data boundary. We scan a window, locate C and inv.C by
	 * correlation, and correct the boundary only on unambiguous evidence; else
	 * use the blind symbol count.
	 */
	private handleSync2(symRect: number): void {
		const levels = this.mode ? this.mode.levels : 2;
		const s2Symbols = (this.baud * 25) / 1000;
		const s2Half = s2Symbols / 2;
		const s2Window = s2Symbols + 2;

		const bitA = symRect > 1 ? 1 : 0;
		if (levels === 4) {
			const bitB = symRect === 1 || symRect === 2 ? 1 : 0;
			this.sync2Shiftreg = ((this.sync2Shiftreg << 2) | (bitA << 1) | bitB) & 0xffff;
		} else {
			this.sync2Shiftreg = ((this.sync2Shiftreg << 1) | bitA) & 0xffff;
		}

		// Buffer symbols around the nominal boundary to replay post-boundary.
		if (this.sync2Count >= s2Symbols - 2 && this.sync2SymBufCount < 4) {
			if (this.sync2SymBufCount === 0) this.sync2SymBufStart = this.sync2Count;
			this.sync2SymBuf[this.sync2SymBufCount] = symRect;
			this.sync2AltSymBuf[this.sync2SymBufCount++] = this.altSymbol;
		}
		this.sync2Count++;

		if (this.sync2Count >= 16) this.correlateS2();

		if (this.sync2Count < s2Window) return;

		// End of scan window: decide the frame-data boundary, enter DATA.
		const boundary = this.decideS2Boundary(s2Symbols, s2Half);
		this.dataCount = 0;
		this.clearPhaseData();
		this.rxState = RX_STATE_DATA;

		// Replay buffered symbols that fall AFTER the decided boundary.
		for (let k = 0; k < this.sync2SymBufCount; k++) {
			const symPos = this.sync2SymBufStart + k;
			if (symPos >= boundary) {
				this.readAltData(this.sync2AltSymBuf[k]);
				this.readData(this.sync2SymBuf[k]);
				this.dataCount++;
			}
		}
	}

	/** Correlate the S2 shift register against C and inv.C, recording first hits. */
	private correlateS2(): void {
		if (!this.sync2CFound) {
			const errs = countBits32(this.sync2Shiftreg ^ FLEX_S2_C);
			if (errs <= 2) {
				this.sync2CFound = 1;
				this.sync2CPos = this.sync2Count;
				this.sync2CErrs = errs;
			}
		}
		if (!this.sync2CinvFound) {
			const errs = countBits32(this.sync2Shiftreg ^ FLEX_S2_C_INV);
			if (errs <= 2) {
				this.sync2CinvFound = 1;
				this.sync2CinvPos = this.sync2Count;
				this.sync2CinvErrs = errs;
			}
		}
	}

	/**
	 * Decide the S2->DATA boundary. Default to the blind nominal count; only
	 * override when C and inv.C are both found, at least one is clean, they sit
	 * exactly s2Half apart, and the offset from nominal is +/-1.
	 */
	private decideS2Boundary(s2Symbols: number, s2Half: number): number {
		if (!this.sync2CFound || !this.sync2CinvFound) return s2Symbols;
		const gap = this.sync2CinvPos - this.sync2CPos;
		const offset = this.sync2CinvPos - s2Symbols;
		const bestErrs = Math.min(this.sync2CErrs, this.sync2CinvErrs);
		if (bestErrs === 0 && gap === s2Half && offset !== 0 && offset >= -1 && offset <= 1) {
			return this.sync2CinvPos;
		}
		return s2Symbols;
	}

	/**
	 * RX_STATE_DATA: read data symbols into the interleaved phase buffers until
	 * EITHER the full data portion (1760 ms of symbols) is consumed OR all
	 * active phases have gone idle (the frame ended early), then fire onFrame
	 * and return to sync hunting.
	 * `if (++data_count == baud*1760/1000 || idle) decode`.
	 */
	private handleData(symRect: number): void {
		const idle = this.readData(symRect);
		const full = ++this.dataCount === (this.baud * 1760) / 1000;
		if (!full && !idle) return;
		this.endData();
	}

	private endData(): void {
		this.finishFrame();
		this.baud = 1600;
		this.rxState = RX_STATE_SYNC1;
		this.s1TailCount = 0;
		this.dataCount = 0;
		this.resetEnvelope();
	}

	/**
	 * The current symbol's [p0, p1] phase-buffer index pair, per mode and the
	 * live phase_toggle. toggle=0: bit_a -> A(0); bit_b -> C(2) at 1600/4FSK
	 * (A3) or B(1) at 3200 (A4). toggle=1 (3200 only): bit_a -> C(2), bit_b ->
	 * D(3). For 2FSK bit_b is 0, so the second index is a harmless unused sink.
	 */
	private phasePair(): [number, number] {
		if (this.baud === 1600) return [0, 2]; // A/C every symbol (A1 ignores p1)
		return this.phaseToggle === 0 ? [0, 1] : [2, 3]; // A/B even, C/D odd
	}

	/**
	 * The phase-buffer indices this mode decodes (ARIB 3.3):
	 *   A1 (1600/2FSK): [A].        A3 (1600/4FSK): [A, C].
	 *   A2 (3200/2FSK): [A, C].     A4 (3200/4FSK): [A, B, C, D].
	 */
	private activePhases(): number[] {
		const levels = this.mode ? this.mode.levels : 2;
		if (this.baud === 1600) return levels === 2 ? [0] : [0, 2];
		return levels === 2 ? [0, 2] : [0, 1, 2, 3];
	}

	/**
	 * Deinterleave one data symbol into the four phase buffers,
	 * per ARIB STD-43A Section 3.3:
	 *   A1 (1600/2FSK): bit_a -> Phase A only.
	 *   A3 (1600/4FSK): bit_a -> Phase A, bit_b -> Phase C (same phase pair every symbol).
	 *   A2 (3200/2FSK): symbols alternate bit_a -> Phase A (even) / Phase C (odd).
	 *   A4 (3200/4FSK): even sym bit_a -> A, bit_b -> B; odd sym bit_a -> C, bit_b -> D.
	 * phase_toggle alternates the phase pair at 3200 baud; at 1600 it stays 0.
	 */
	private readData(sym: number): boolean {
		const levels = this.mode ? this.mode.levels : 2;
		const bitA = sym > 1 ? 1 : 0;
		const bitB = levels === 4 && (sym === 1 || sym === 2) ? 1 : 0;

		if (this.baud === 1600) this.phaseToggle = 0;

		const idx = ((this.dataBitCounter >> 5) & 0xfff8) | (this.dataBitCounter & 0x0007);
		if (idx >= FLEX_WORDS_PER_FRAME) return false;

		const [p0, p1] = this.phasePair();
		this.shiftWord(p0, idx, bitA, this.symBitALow, this.symBitBLow);
		this.shiftWord(p1, idx, bitB, this.symBitALow, this.symBitBLow);

		// Idle-word tracking at each 256-bit boundary (for early termination).
		if ((this.dataBitCounter & 0xff) === 0xff) {
			if (this.phases[p0].words[idx] === 0 || this.phases[p0].words[idx] === 0xffffffff) this.phases[p0].idleCount++;
			if (this.phases[p1].words[idx] === 0 || this.phases[p1].words[idx] === 0xffffffff) this.phases[p1].idleCount++;
		}

		this.phaseToggle = this.phaseToggle === 0 ? 1 : 0;
		if (this.baud === 1600 || this.phaseToggle === 0) this.dataBitCounter++;
		return this.allPhasesIdle();
	}

	/** True once every active phase for this mode has seen an idle (all-0/all-1)
	 * word — the data portion has ended early (
	 * IDLE_THRESHOLD = 0). */
	private allPhasesIdle(): boolean {
		for (const pi of this.activePhases()) {
			if (this.phases[pi].idleCount <= IDLE_THRESHOLD) return false;
		}
		return true;
	}

	/** Shift one bit MSB-first into a phase word and its confidence masks. */
	private shiftWord(phaseIdx: number, idx: number, bit: number, bitaLow: number, bitbLow: number): void {
		const ph = this.phases[phaseIdx];
		ph.words[idx] = ((ph.words[idx] >>> 1) | (bit ? 0x80000000 : 0)) >>> 0;
		ph.receivedBits![idx]++;
		ph.lowConfBitA[idx] = ((ph.lowConfBitA[idx] >>> 1) | (bitaLow ? 0x80000000 : 0)) >>> 0;
		ph.lowConfBitB[idx] = ((ph.lowConfBitB[idx] >>> 1) | (bitbLow ? 0x80000000 : 0)) >>> 0;
	}

	/**
	 * Feed the integrate-and-dump alternate symbol into the alt phase buffers,
	 * mirroring the interleaving of readData. Used as a per-word BCH fallback.
	 */
	private readAltData(altSym: number): void {
		const levels = this.mode ? this.mode.levels : 2;
		const bitA = altSym > 1 ? 1 : 0;
		const bitB = levels === 4 && (altSym === 1 || altSym === 2) ? 1 : 0;
		const idx = ((this.dataBitCounter >> 5) & 0xfff8) | (this.dataBitCounter & 0x0007);
		if (idx >= FLEX_WORDS_PER_FRAME) return;
		// The alt slicer runs before readData flips phase_toggle, so at 1600 it
		// must treat toggle as 0 explicitly (readData forces it there too).
		const [p0, p1] = this.phasePair();
		this.phases[p0].altWords[idx] = ((this.phases[p0].altWords[idx] >>> 1) | (bitA ? 0x80000000 : 0)) >>> 0;
		this.phases[p1].altWords[idx] = ((this.phases[p1].altWords[idx] >>> 1) | (bitB ? 0x80000000 : 0)) >>> 0;
		this.phases[p0].altReceivedBits![idx]++;
		this.phases[p1].altReceivedBits![idx]++;
	}

	/** Emit received phase words at full-frame, idle, or lock-loss termination. */
	private finishFrame(): void {
		if (!this.fiw) return;
		// Active phase indices per mode (A1:[A], A2/A3:[A,C], A4:[A,B,C,D]).
		this.ev.onFrame?.(this.phases, this.activePhases(), this.fiw, this.polarity);
	}

	/**
	 * Provisional mode identification at marker-detection time. Captures the A
	 * code and BCH-corrects it so a 1-2 bit
	 * error in the outer code still identifies the mode -- the raw 16-bit code
	 * from the Hamming-tolerant marker match is not trusted on its own. The
	 * authoritative validation is the later combined A/inv.A correction.
	 */
	private decodeMode(syncCode: number, polarity: number): boolean {
		// Capture the 32-bit A code: at marker detection it sits at syncHi.
		// Raw register holds ~A (pol=0) or A (pol=1).
		const aCode = polarity ? this.syncHi : ~this.syncHi >>> 0;
		this.syncACode = aCode;

		// BCH-correct the A code; derive the corrected 16-bit sync when it
		// decodes, else fall back to the raw marker-matched code.
		const r = bchDecode(aCode);
		const correctedSync = r.info >= 0 ? (~r.corrected >>> 16) & 0xffff : 0;
		const code = correctedSync !== 0 ? correctedSync : syncCode;

		// Accept a functional mode OR a recognized reserved/Ar code: the latter
		// has no mode but must reach the S1 tail stage to be logged (gated there
		// on a 100%-error-free match). An unrecognized code is rejected here.
		return MODES.some((m) => m.syncCode === code) || SYNC_CODE_TABLE.some((s) => s.code === code);
	}

	/**
	 * A validated S1 sync whose outer code is not a functional mode (A1-A4):
	 * either the Ar ERS code or a Reserved code (A5-A15).
	 *
	 *   * Ar (ERS): a valid, specified sync. combinedACorrection has already
	 *     validated A against inv.A, so it is reported unconditionally, and the
	 *     receiver reacts per Section 3.2.1 by RE-SYNCHRONIZING: drop lock and
	 *     clear sync state so the next real A1-A4 frame is re-acquired cleanly
	 *     (the Ar burst itself carries no FIW/S2/data to decode).
	 *   * Reserved (A5-A15): reported ONLY when both the raw A and raw inv.A
	 *     decode BCH-CLEAN (zero bit errors), so a corrupted A1-A4 that
	 *     combinedACorrection might coerce toward a reserved pattern can never
	 *     raise a false reserved report. `rawA`/`rawInvA` are pre-correction.
	 */
	private reportNonModeSync(finalSync: number, rawA: number, rawInvA: number): void {
		const entry = SYNC_CODE_TABLE.find((s) => s.code === finalSync);
		if (!entry) return; // unknown 16-bit code -> not recognized, stay silent

		if (entry.ers) {
			// ERS: fire event on every Ar frame so lastSyncEvent.ts stays fresh
			// and the UI badge holds ERS for the duration of the burst.
			// ersReported is still set (for logging dedup in the app layer) but
			// no longer gates the event — re-arms on each unlock via setLocked.
			this.ev.onSyncCode?.({ code: finalSync, label: entry.label, ers: true, polarity: this.polarity });
			this.ersReported = true;
			// Drop lock per spec §3.2.1: pager must re-synchronize from the burst.
			this.setLocked(false);
			return;
		}

		// Reserved code: require a 100%-error-free match to avoid false positives.
		const aClean = bchDecode(rawA).status === BCH_CLEAN;
		const invClean = bchDecode(~rawInvA >>> 0).status === BCH_CLEAN;
		if (!aClean || !invClean) return;
		this.ev.onSyncCode?.({ code: finalSync, label: entry.label, ers: false, polarity: this.polarity });
	}

	// -- read-only accessors for callers / tests --
	get locked(): boolean {
		return this.pllLocked;
	}
	get state(): number {
		return this.rxState;
	}
	get detectedMode(): FlexMode | null {
		return this.mode;
	}
	get detectedPolarity(): number {
		return this.polarity;
	}
	get lastFiw(): FlexFiw | null {
		return this.fiw;
	}
}
