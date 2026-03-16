/*
Copyright (c) 2026, jLynx <https://github.com/jLynx>

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
	Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
	Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the
	documentation and/or other materials provided with the distribution.
	Neither the name of Great Scott Gadgets nor the names of its contributors may be used to endorse or promote products derived from this software
	without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import type { RDSMessage } from './types';

// ── RDS Constants ────────────────────────────────────────────────
const RDS_BITRATE = 1187.5;
const RDS_SUBCARRIER = 57000;

// Offset words for each block position (10-bit, per IEC 62106)
const OFFSET_A  = 0x0FC;
const OFFSET_B  = 0x198;
const OFFSET_C  = 0x168;
const OFFSET_CP = 0x350;
const OFFSET_D  = 0x1B4;

// Generator polynomial for RDS checkword (x^10 + x^8 + x^7 + x^5 + x^4 + x^3 + 1)
const RDS_POLY = 0x5B9; // 10-bit: 10110111001
const SYNDROME_A  = calcSyndrome(OFFSET_A);
const SYNDROME_B  = calcSyndrome(OFFSET_B);
const SYNDROME_C  = calcSyndrome(OFFSET_C);
const SYNDROME_CP = calcSyndrome(OFFSET_CP);
const SYNDROME_D  = calcSyndrome(OFFSET_D);

function calcSyndrome(offset: number): number {
	let reg = 0;
	for (let i = 25; i >= 0; i--) {
		const bit = (i >= 10) ? 0 : ((offset >> i) & 1);
		const fb = ((reg >> 9) & 1) ^ bit;
		reg = ((reg << 1) & 0x3FF);
		if (fb) reg ^= RDS_POLY;
	}
	return reg;
}

function computeSyndrome(block: number): number {
	let reg = 0;
	for (let i = 25; i >= 0; i--) {
		const fb = ((reg >> 9) & 1) ^ ((block >> i) & 1);
		reg = ((reg << 1) & 0x3FF);
		if (fb) reg ^= RDS_POLY;
	}
	return reg;
}

// EU PTY labels (0-31)
const PTY_LABELS_EU = [
	'None', 'News', 'Current Affairs', 'Information', 'Sport', 'Education',
	'Drama', 'Culture', 'Science', 'Varied', 'Pop Music', 'Rock Music',
	'Easy Listening', 'Light Classical', 'Serious Classical', 'Other Music',
	'Weather', 'Finance', 'Children', 'Social Affairs', 'Religion',
	'Phone In', 'Travel', 'Leisure', 'Jazz Music', 'Country Music',
	'National Music', 'Oldies Music', 'Folk Music', 'Documentary',
	'Alarm Test', 'Alarm'
];

// NA (RBDS) PTY labels
const PTY_LABELS_NA = [
	'None', 'News', 'Information', 'Sports', 'Talk', 'Rock',
	'Classic Rock', 'Adult Hits', 'Soft Rock', 'Top 40', 'Country',
	'Oldies', 'Soft', 'Nostalgia', 'Jazz', 'Classical',
	'R&B', 'Soft R&B', 'Language', 'Religious Music', 'Religious Talk',
	'Personality', 'Public', 'College', 'Spanish Talk', 'Spanish Music',
	'Hip Hop', '', '', 'Weather', 'Emergency Test', 'Emergency'
];

// ── Biquad Filter Section ────────────────────────────────────────
// Direct Form II Transposed biquad for numerical stability

class BiquadSection {
	private b0: number;
	private b1: number;
	private b2: number;
	private a1: number;
	private a2: number;
	private x1 = 0;
	private x2 = 0;
	private y1 = 0;
	private y2 = 0;

	constructor(b0: number, b1: number, b2: number, a1: number, a2: number) {
		this.b0 = b0; this.b1 = b1; this.b2 = b2;
		this.a1 = a1; this.a2 = a2;
	}

	process(x: number): number {
		const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
			- this.a1 * this.y1 - this.a2 * this.y2;
		this.x2 = this.x1; this.x1 = x;
		this.y2 = this.y1; this.y1 = y;
		return y;
	}

	reset(): void {
		this.x1 = 0; this.x2 = 0;
		this.y1 = 0; this.y2 = 0;
	}
}

/** Create a 4th-order Butterworth low-pass filter (two cascaded biquads).
 *  Provides 24 dB/octave rolloff — much better than single-pole IIR (6 dB/oct). */
function makeButterworthLpf4(cutoffHz: number, sampleRate: number): BiquadSection[] {
	// Q values for 4th-order Butterworth (from poles at ±22.5° and ±67.5°)
	const Qs = [0.54119610, 1.30656296];
	return Qs.map(Q => {
		const w0 = 2 * Math.PI * cutoffHz / sampleRate;
		const sinW0 = Math.sin(w0);
		const cosW0 = Math.cos(w0);
		const alpha = sinW0 / (2 * Q);
		const a0 = 1 + alpha;
		return new BiquadSection(
			(1 - cosW0) / 2 / a0,    // b0
			(1 - cosW0) / a0,         // b1
			(1 - cosW0) / 2 / a0,    // b2
			-2 * cosW0 / a0,          // a1
			(1 - alpha) / a0           // a2
		);
	});
}

// ── RDS Decoder ──────────────────────────────────────────────────

export class RDSDecoder {
	private callback: (msg: RDSMessage) => void;
	private region: string;

	// 57 kHz carrier
	private carrierPhase: number = 0;
	private carrierPhaseInc: number;

	// 4th-order Butterworth LPF for I and Q channels (replaces single-pole IIR)
	private bqI: BiquadSection[];
	private bqQ: BiquadSection[];

	// Costas loop for carrier recovery (eliminates carrier phase dependency)
	private loopAlpha: number;  // proportional gain
	private loopBeta: number;   // integral gain
	private loopIntegrator: number = 0;

	// Clock recovery (1187.5 bps)
	private samplesPerBit: number;
	private clockPhase: number = 0;
	private prevBpskI: number = 0;

	// Differential decode using complex conjugate product (carrier-independent)
	private prevSymI: number = 0;
	private prevSymQ: number = 0;

	// Block assembly
	private shiftReg: number = 0;
	private bitCount: number = 0;

	// Sync state machine
	private synced: boolean = false;
	private blockIndex: number = 0; // 0=A, 1=B, 2=C, 3=D
	private goodBlocks: number = 0;
	private blocks: number[] = [0, 0, 0, 0]; // data words (16 bits each)
	private blockValid: boolean[] = [false, false, false, false]; // per-block CRC validity
	private blockErrors: number = 0;

	// Decoded RDS data
	private pi: number = 0;
	private pty: number = -1;
	private tp: boolean = false;
	private ta: boolean = false;
	private psChars: (number | null)[] = new Array(8).fill(null);
	private psConfirm: (number | null)[] = new Array(8).fill(null); // confirm-on-second-reception
	private rtChars: (number | null)[] = new Array(64).fill(null);
	private rtConfirm: (number | null)[] = new Array(64).fill(null);
	private rtAbFlag: number = -1;
	private lastPs: string = '';
	private lastRt: string = '';

	constructor(sampleRate: number, callback: (msg: RDSMessage) => void, region: string = 'eu') {
		this.callback = callback;
		this.region = region;

		this.carrierPhaseInc = 2 * Math.PI * RDS_SUBCARRIER / sampleRate;
		this.samplesPerBit = sampleRate / RDS_BITRATE;

		// 4th-order Butterworth LPF at 2.4 kHz
		// At 19 kHz (nearest interferer after 57 kHz mixing): ~72 dB rejection
		// vs. single-pole IIR which only gave ~18 dB
		this.bqI = makeButterworthLpf4(2400, sampleRate);
		this.bqQ = makeButterworthLpf4(2400, sampleRate);

		// Costas loop: 2nd-order PLL with ~50 Hz natural frequency
		// Converges in ~20 ms, tracks carrier phase without affecting data
		const loopBW = 50;
		const wn = 2 * Math.PI * loopBW / sampleRate;
		const zeta = 0.707; // critically damped
		this.loopAlpha = 2 * zeta * wn;
		this.loopBeta = wn * wn;
	}

	process(samples: Float32Array): void {
		for (let i = 0; i < samples.length; i++) {
			const sample = samples[i];

			// ── Mix with 57 kHz carrier (phase includes Costas correction) ──
			const cosVal = Math.cos(this.carrierPhase);
			const sinVal = Math.sin(this.carrierPhase);
			this.carrierPhase += this.carrierPhaseInc;

			const rawI = sample * cosVal;
			const rawQ = sample * sinVal;

			// ── 4th-order Butterworth LPF on I and Q ──
			let filtI = rawI;
			for (let k = 0; k < this.bqI.length; k++) filtI = this.bqI[k].process(filtI);
			let filtQ = rawQ;
			for (let k = 0; k < this.bqQ.length; k++) filtQ = this.bqQ[k].process(filtQ);

			// ── Costas loop: carrier phase recovery ──
			// Error signal: I×Q / (I²+Q²) — normalized, stable at φ=0 and φ=π
			// Both lock points are valid for BPSK (differential decode handles π ambiguity)
			const power = filtI * filtI + filtQ * filtQ;
			if (power > 1e-12) {
				const loopError = (filtI * filtQ) / power;
				this.loopIntegrator += loopError * this.loopBeta;
				// Clamp integrator to prevent wind-up (no freq offset in digital system)
				if (this.loopIntegrator > 0.01) this.loopIntegrator = 0.01;
				else if (this.loopIntegrator < -0.01) this.loopIntegrator = -0.01;
				this.carrierPhase -= loopError * this.loopAlpha + this.loopIntegrator;
			}

			// Wrap carrier phase
			if (this.carrierPhase > 2 * Math.PI) this.carrierPhase -= 2 * Math.PI;
			else if (this.carrierPhase < 0) this.carrierPhase += 2 * Math.PI;

			// ── Clock recovery ──
			// Zero-crossing PLL on I component (now aligned by Costas loop)
			this.clockPhase += 1.0;
			if ((filtI > 0) !== (this.prevBpskI > 0)) {
				const error = this.clockPhase - this.samplesPerBit / 2;
				this.clockPhase -= error * 0.1;
			}
			this.prevBpskI = filtI;

			// ── Sample at bit boundary ──
			if (this.clockPhase >= this.samplesPerBit) {
				this.clockPhase -= this.samplesPerBit;

				// Differential decode using complex conjugate product:
				// diffProd = Re{z[n] × conj(z[n-1])} = I·Iprev + Q·Qprev
				// Positive → same phase (bit 0), Negative → π phase change (bit 1)
				// This works regardless of carrier phase offset!
				const diffProd = filtI * this.prevSymI + filtQ * this.prevSymQ;
				const decodedBit = diffProd < 0 ? 1 : 0;
				this.prevSymI = filtI;
				this.prevSymQ = filtQ;

				this.processBit(decodedBit);
			}
		}
	}

	private processBit(bit: number): void {
		// Shift bit into 26-bit register
		this.shiftReg = ((this.shiftReg << 1) | bit) & 0x3FFFFFF;
		this.bitCount++;

		if (!this.synced) {
			// Try to find sync by checking syndrome against all offset words
			if (this.bitCount >= 26) {
				const syn = computeSyndrome(this.shiftReg);
				if (syn === SYNDROME_A) {
					this.synced = true;
					this.goodBlocks = 1;
					this.blocks[0] = (this.shiftReg >> 10) & 0xFFFF;
					this.blockIndex = 1;
					this.bitCount = 0;
				} else if (syn === SYNDROME_B) {
					this.synced = true;
					this.goodBlocks = 0;
					this.blocks[1] = (this.shiftReg >> 10) & 0xFFFF;
					this.blockIndex = 2;
					this.bitCount = 0;
				} else if (syn === SYNDROME_C || syn === SYNDROME_CP) {
					this.synced = true;
					this.goodBlocks = 0;
					this.blocks[2] = (this.shiftReg >> 10) & 0xFFFF;
					this.blockIndex = 3;
					this.bitCount = 0;
				} else if (syn === SYNDROME_D) {
					this.synced = true;
					this.goodBlocks = 0;
					this.blocks[3] = (this.shiftReg >> 10) & 0xFFFF;
					this.blockIndex = 0;
					this.bitCount = 0;
				}
			}
			return;
		}

		// Synced: wait for 26 bits per block
		if (this.bitCount < 26) return;
		this.bitCount = 0;

		const syn = computeSyndrome(this.shiftReg);
		const expectedSyndromes = [SYNDROME_A, SYNDROME_B, SYNDROME_C, SYNDROME_D];
		// Block C can also be C' (for type B groups)
		const expectedSyn = expectedSyndromes[this.blockIndex];
		const isValid = (syn === expectedSyn) ||
			(this.blockIndex === 2 && syn === SYNDROME_CP);

		if (isValid) {
			this.blocks[this.blockIndex] = (this.shiftReg >> 10) & 0xFFFF;
			this.blockValid[this.blockIndex] = true;
			this.goodBlocks++;
			this.blockErrors = 0;
		} else {
			this.blockValid[this.blockIndex] = false;
			this.blockErrors++;
			if (this.blockErrors > 10) {
				// Lost sync
				this.synced = false;
				this.goodBlocks = 0;
				this.blockErrors = 0;
				return;
			}
		}

		// Advance block position
		this.blockIndex = (this.blockIndex + 1) & 3;

		// After block D (index wraps to 0), decode the group
		if (this.blockIndex === 0 && this.goodBlocks >= 2) {
			this.decodeGroup();
		}
		if (this.blockIndex === 0) {
			this.goodBlocks = 0;
			this.blockValid.fill(false);
		}
	}

	/** Accept a character only after it has been received identically twice
	 *  at the same position (standard RDS error-rejection technique). */
	private confirmChar(pos: number, char: number, chars: (number | null)[], confirm: (number | null)[]): void {
		if (char < 0x20 || char >= 0x7F) return;
		if (confirm[pos] === char) {
			chars[pos] = char; // confirmed — accept
		}
		confirm[pos] = char;
	}

	private decodeGroup(): void {
		const bv = this.blockValid;

		// Block A: PI code — only if block A passed CRC
		if (bv[0]) {
			const pi = this.blocks[0];
			if (pi !== this.pi && pi !== 0) {
				this.pi = pi;
				const piHex = pi.toString(16).toUpperCase().padStart(4, '0');
				this.callback({ pi: piHex });
			}
		}

		// Block B must be valid — it contains group type, PTY, segment index
		if (!bv[1]) return;
		const blockB = this.blocks[1];

		const groupType = (blockB >> 12) & 0xF;
		const groupVersion = (blockB >> 11) & 1; // 0=A, 1=B
		const tp = ((blockB >> 10) & 1) === 1;
		const pty = (blockB >> 5) & 0x1F;

		// TP flag
		if (tp !== this.tp) {
			this.tp = tp;
			this.callback({ tp });
		}

		// PTY
		if (pty !== this.pty) {
			this.pty = pty;
			const labels = this.region === 'na' ? PTY_LABELS_NA : PTY_LABELS_EU;
			this.callback({ pty, ptyLabel: labels[pty] || '' });
		}

		// Group 0: Basic tuning and PS name — need block D valid
		if (groupType === 0 && bv[3]) {
			const ta = (blockB & 0x10) !== 0;
			if (ta !== this.ta) {
				this.ta = ta;
				this.callback({ ta });
			}

			// PS name: 2 chars per group 0, segment from bits 1:0 of block B
			const segment = blockB & 0x03;
			const blockD = this.blocks[3];
			const c1 = (blockD >> 8) & 0xFF;
			const c2 = blockD & 0xFF;

			this.confirmChar(segment * 2, c1, this.psChars, this.psConfirm);
			this.confirmChar(segment * 2 + 1, c2, this.psChars, this.psConfirm);

			// Check if PS is complete (all 8 chars received)
			const ps = this.buildPS();
			if (ps && ps !== this.lastPs) {
				this.lastPs = ps;
				this.callback({ ps });
			}
		}

		// Group 2: RadioText
		if (groupType === 2) {
			const abFlag = (blockB >> 4) & 1;

			// A/B flag change means new RT message — clear buffer
			if (this.rtAbFlag !== -1 && abFlag !== this.rtAbFlag) {
				this.rtChars.fill(null);
				this.rtConfirm.fill(null);
			}
			this.rtAbFlag = abFlag;

			const segment = blockB & 0x0F;

			if (groupVersion === 0 && bv[2] && bv[3]) {
				// 2A: 4 chars per segment (from blocks C and D)
				const blockC = this.blocks[2];
				const blockD = this.blocks[3];
				const c1 = (blockC >> 8) & 0xFF;
				const c2 = blockC & 0xFF;
				const c3 = (blockD >> 8) & 0xFF;
				const c4 = blockD & 0xFF;
				const base = segment * 4;
				this.confirmChar(base, c1, this.rtChars, this.rtConfirm);
				this.confirmChar(base + 1, c2, this.rtChars, this.rtConfirm);
				this.confirmChar(base + 2, c3, this.rtChars, this.rtConfirm);
				this.confirmChar(base + 3, c4, this.rtChars, this.rtConfirm);

				// Check for end-of-message marker (0x0D)
				if (c1 === 0x0D || c2 === 0x0D || c3 === 0x0D || c4 === 0x0D) {
					const rt = this.buildRT();
					if (rt && rt !== this.lastRt) {
						this.lastRt = rt;
						this.callback({ rt });
					}
				}
			} else if (groupVersion === 1 && bv[3]) {
				// 2B: 2 chars per segment (from block D only)
				const blockD = this.blocks[3];
				const c1 = (blockD >> 8) & 0xFF;
				const c2 = blockD & 0xFF;
				const base = segment * 2;
				this.confirmChar(base, c1, this.rtChars, this.rtConfirm);
				this.confirmChar(base + 1, c2, this.rtChars, this.rtConfirm);
			}

			// Periodically emit partial RT
			const rt = this.buildRT();
			if (rt && rt.length >= 4 && rt !== this.lastRt) {
				this.lastRt = rt;
				this.callback({ rt });
			}
		}
	}

	private buildPS(): string | null {
		if (this.psChars.some(c => c === null)) return null;
		return String.fromCharCode(...(this.psChars as number[]));
	}

	private buildRT(): string | null {
		let end = 0;
		for (let i = 0; i < 64; i++) {
			if (this.rtChars[i] !== null) end = i + 1;
		}
		if (end === 0) return null;

		let s = '';
		for (let i = 0; i < end; i++) {
			s += this.rtChars[i] !== null ? String.fromCharCode(this.rtChars[i]!) : ' ';
		}
		return s.trimEnd();
	}

	reset(): void {
		this.synced = false;
		this.blockIndex = 0;
		this.goodBlocks = 0;
		this.blockErrors = 0;
		this.blockValid.fill(false);
		this.bitCount = 0;
		this.shiftReg = 0;
		this.pi = 0;
		this.pty = -1;
		this.tp = false;
		this.ta = false;
		this.psChars.fill(null);
		this.psConfirm.fill(null);
		this.rtChars.fill(null);
		this.rtConfirm.fill(null);
		this.rtAbFlag = -1;
		this.lastPs = '';
		this.lastRt = '';
		this.carrierPhase = 0;
		this.clockPhase = 0;
		this.prevBpskI = 0;
		this.prevSymI = 0;
		this.prevSymQ = 0;
		this.loopIntegrator = 0;
		for (const bq of this.bqI) bq.reset();
		for (const bq of this.bqQ) bq.reset();
	}
}
