/*
 * DSD DSP front-end: RRC filter, clock recovery, and 4-FSK slicer.
 * Ported from SDR++ Brown ch_extravhf_decoder.
 */

import { DSD_SYMBOL_RATE, DSD_IF_RATE, SLICER_MID_FACTOR } from './constants';

// ── Root Raised Cosine (RRC) Filter ──────────────────────────────────

/**
 * Generate RRC filter taps.
 * @param numTaps Number of filter taps (should be odd)
 * @param sampleRate Input sample rate
 * @param symbolRate Symbol rate (4800 for DSD)
 * @param alpha Roll-off factor (0.2 for DSD)
 */
export function rrcTaps(numTaps: number, sampleRate: number, symbolRate: number, alpha: number): Float32Array {
	const taps = new Float32Array(numTaps);
	const Ts = sampleRate / symbolRate; // samples per symbol
	const mid = (numTaps - 1) / 2;
	let sum = 0;

	for (let i = 0; i < numTaps; i++) {
		const t = (i - mid) / Ts;
		let h: number;

		if (t === 0) {
			h = (1 / Ts) * (1 + alpha * (4 / Math.PI - 1));
		} else if (Math.abs(Math.abs(t) - 1 / (4 * alpha)) < 1e-8) {
			h =
				(alpha / (Ts * Math.SQRT2)) *
				((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * alpha)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * alpha)));
		} else {
			const piT = Math.PI * t;
			const fourAlphaT = 4 * alpha * t;
			h = ((1 / Ts) * (Math.sin(piT * (1 - alpha)) + fourAlphaT * Math.cos(piT * (1 + alpha)))) / (piT * (1 - fourAlphaT * fourAlphaT));
		}

		taps[i] = h;
		sum += h * h;
	}

	// Normalize energy
	const norm = 1 / Math.sqrt(sum);
	for (let i = 0; i < numTaps; i++) taps[i] *= norm;

	return taps;
}

/**
 * Simple FIR filter operating on float samples.
 */
export class FIRFilter {
	private taps: Float32Array;
	private buffer: Float32Array;
	private bufIdx: number;
	private numTaps: number;

	constructor(taps: Float32Array) {
		this.taps = taps;
		this.numTaps = taps.length;
		this.buffer = new Float32Array(this.numTaps);
		this.bufIdx = 0;
	}

	processSample(sample: number): number {
		this.buffer[this.bufIdx] = sample;
		let sum = 0;
		let idx = this.bufIdx;
		for (let i = 0; i < this.numTaps; i++) {
			sum += this.taps[i] * this.buffer[idx];
			if (--idx < 0) idx = this.numTaps - 1;
		}
		this.bufIdx = (this.bufIdx + 1) % this.numTaps;
		return sum;
	}

	process(input: Float32Array, output: Float32Array): void {
		for (let i = 0; i < input.length; i++) {
			output[i] = this.processSample(input[i]);
		}
	}

	reset(): void {
		this.buffer.fill(0);
		this.bufIdx = 0;
	}
}

// ── Gardner Clock Recovery ──────────────────────────────────────────

/**
 * Clock recovery using a Gardner timing error detector.
 * Extracts one symbol per symbol period from the input stream.
 *
 * Operates on RRC-filtered samples at 48 kHz to extract 4800 symbols/s.
 */
export class ClockRecovery {
	private omega: number; // nominal samples per symbol
	private nextSymbolTime = 0;
	private sampleIndex = 0;
	private previousInput = 0;
	private omegaGain: number; // loop filter gain for omega
	private muGain: number; // loop filter gain for mu
	private prevSample: number;
	private history = new Float32Array(128);
	private previousSymbolTime = 0;
	private power = 0;
	private omegaRel: number; // relative omega limit
	private omegaMid: number; // nominal omega (for limiting)

	/** Output buffer for extracted symbols */
	symbolBuf: Float32Array;
	symbolCount: number;

	constructor(sampleRate: number = DSD_IF_RATE, symbolRate: number = DSD_SYMBOL_RATE) {
		this.omega = sampleRate / symbolRate;
		this.omegaMid = this.omega;
		this.prevSample = 0;
		this.omegaRel = 0.005; // relative limit on omega adjustment

		// Phase acquisition is faster than frequency tracking: repetitive AMBE
		// payloads must not pull the symbol rate away from 4800 symbols/s.
		this.muGain = 0.05;
		this.omegaGain = 0.00001;

		this.symbolBuf = new Float32Array(4096);
		this.symbolCount = 0;
	}

	/**
	 * Process a block of RRC-filtered samples and extract symbols.
	 * Call this with each new chunk from the RRC filter.
	 * After calling, read symbolBuf[0..symbolCount-1] for extracted symbols.
	 */
	process(input: Float32Array): void {
		this.symbolCount = 0;
		for (const sample of input) {
			this.history[this.sampleIndex % this.history.length] = sample;
			this.power += 0.001 * (sample * sample - this.power);
			if (this.sampleIndex < this.nextSymbolTime) {
				this.previousInput = sample;
				this.sampleIndex++;
				continue;
			}

			// Keep the interpolation sample and absolute symbol position across
			// blocks. Discarding a skip past a block's end changes symbol timing.
			const fraction = this.nextSymbolTime - (this.sampleIndex - 1);
			const curSample = this.sampleIndex === 0 ? sample : this.previousInput * (1 - fraction) + sample * fraction;

			// Gardner timing error uses the midpoint between adjacent symbols.
			// Sign-only M&M decisions mistake DMR's inner and outer levels for
			// the same amplitude and drift on repeating AMBE payloads.
			const midpointTime = (this.previousSymbolTime + this.nextSymbolTime) / 2;
			const midpointIndex = Math.floor(midpointTime);
			const midpointFraction = midpointTime - midpointIndex;
			const midpoint =
				this.history[midpointIndex % this.history.length] * (1 - midpointFraction) +
				this.history[(midpointIndex + 1) % this.history.length] * midpointFraction;
			const timingError =
				this.sampleIndex === 0 ? 0 : Math.max(-1, Math.min(1, ((this.prevSample - curSample) * midpoint) / Math.max(this.power, 1e-8)));

			// Update loop
			this.omega += this.omegaGain * timingError;
			// Clamp omega
			const omegaMin = this.omegaMid * (1 - this.omegaRel);
			const omegaMax = this.omegaMid * (1 + this.omegaRel);
			if (this.omega < omegaMin) this.omega = omegaMin;
			if (this.omega > omegaMax) this.omega = omegaMax;

			this.previousSymbolTime = this.nextSymbolTime;
			this.nextSymbolTime += this.omega + this.muGain * timingError;

			// Store state for next iteration
			this.prevSample = curSample;

			if (this.symbolCount >= this.symbolBuf.length) {
				const newBuf = new Float32Array(this.symbolBuf.length * 2);
				newBuf.set(this.symbolBuf);
				this.symbolBuf = newBuf;
			}
			this.symbolBuf[this.symbolCount++] = curSample;
			this.previousInput = sample;
			this.sampleIndex++;
		}
	}

	reset(): void {
		this.omega = this.omegaMid;
		this.nextSymbolTime = 0;
		this.sampleIndex = 0;
		this.previousInput = 0;
		this.prevSample = 0;
		this.history.fill(0);
		this.previousSymbolTime = 0;
		this.power = 0;
		this.symbolCount = 0;
	}
}

// ── 4-FSK Slicer ─────────────────────────────────────────────────────

/**
 * 4-FSK symbol slicer with adaptive threshold levels.
 * Converts float symbols to 2-bit dibits.
 *
 * Symbol mapping (following SDR++ Brown / DSD convention):
 *   >= umid → 01 (+3)
 *   >= center → 00 (+1)
 *   >= lmid → 10 (-1)
 *   < lmid → 11 (-3)
 */
export class FourFSKSlicer {
	max = 1.0;
	min = -1.0;
	center = 0.0;
	umid = 0.625; // upper mid threshold
	lmid = -0.625; // lower mid threshold
	mid = SLICER_MID_FACTOR;

	// Estimate outer levels from a short symbol window. Averaging all positive
	// symbols treats +1 as +3 and moves the threshold into the inner cluster.
	private levels = new Float32Array(144);
	private levelCount = 0;
	private levelPosition = 0;

	/** Slice a single symbol to a 2-bit dibit value (0-3). */
	slice(sym: number): number {
		this.levels[this.levelPosition++ % this.levels.length] = sym;
		this.levelCount = Math.min(this.levelCount + 1, this.levels.length);
		if (this.levelPosition % 24 === 0) {
			const sorted = this.levels.slice(0, this.levelCount).sort();
			// Percentiles reject isolated spikes without averaging inner symbols.
			this.min = sorted[Math.floor((this.levelCount - 1) * 0.1)];
			this.max = sorted[Math.floor((this.levelCount - 1) * 0.9)];
		}

		this.center = (this.max + this.min) * 0.5;
		this.umid = (this.max - this.center) * this.mid + this.center;
		this.lmid = (this.min - this.center) * this.mid + this.center;

		if (sym >= this.umid) return 0b01;
		if (sym >= this.center) return 0b00;
		if (sym >= this.lmid) return 0b10;
		return 0b11;
	}

	/**
	 * Slice a buffer of symbols to dibits.
	 * @param symbols Input float symbols
	 * @param dibits Output Uint8Array of dibit values (0-3)
	 * @param count Number of symbols to process
	 */
	process(symbols: Float32Array, dibits: Uint8Array, count: number): void {
		for (let i = 0; i < count; i++) {
			dibits[i] = this.slice(symbols[i]);
		}
	}

	reset(): void {
		this.max = 1.0;
		this.min = -1.0;
		this.center = 0.0;
		this.umid = 0.625;
		this.lmid = -0.625;
		this.levels.fill(0);
		this.levelCount = 0;
		this.levelPosition = 0;
	}
}

// ── FM Discriminator (for IQ → baseband audio) ──────────────────────

/**
 * Simple FM discriminator using atan2 phase difference.
 * Converts complex IQ samples to real FM audio.
 */
export class FMDiscriminator {
	private prevI = 0;
	private prevQ = 0;

	/**
	 * Process interleaved IQ samples (I0, Q0, I1, Q1, ...) to FM audio.
	 * @param iq Interleaved Float32Array [I, Q, I, Q, ...]
	 * @param audio Output Float32Array (half the length of iq)
	 */
	process(iq: Float32Array, audio: Float32Array): void {
		const numSamples = iq.length / 2;
		for (let i = 0; i < numSamples; i++) {
			const curI = iq[i * 2];
			const curQ = iq[i * 2 + 1];
			// Conjugate multiply: (curI + j*curQ) * (prevI - j*prevQ)
			const dI = curI * this.prevI + curQ * this.prevQ;
			const dQ = curQ * this.prevI - curI * this.prevQ;
			audio[i] = Math.atan2(dQ, dI);
			this.prevI = curI;
			this.prevQ = curQ;
		}
	}

	reset(): void {
		this.prevI = 0;
		this.prevQ = 0;
	}
}
