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

import type { POCSAGMessage } from './types';

/**
 * POCSAG paging protocol decoder.
 * Operates on FM-demodulated Float32 audio samples (typically 48 kHz).
 *
 * Runs two independent baud-rate decoders in parallel (1200 Bd and 512 Bd),
 * so both rates are always active simultaneously.  Each sub-decoder uses a
 * zero-crossing PLL that correctly aligns sampling to the CENTER of each bit
 * (zero crossings must land at spb/2, not at the sample point).
 * Sync word detection tolerates up to 2 bit-errors via Hamming distance.
 */

/** Hamming distance between two 32-bit integers. */
export function _pocsagHamming(a: number, b: number): number {
	let x = (a ^ b) >>> 0;
	x -= (x >>> 1) & 0x55555555;
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	x = (x + (x >>> 4)) & 0x0f0f0f0f;
	return Math.imul(x, 0x01010101) >>> 24;
}

interface ECCTables {
	ecs: Uint32Array;
	bch: Uint32Array;
}

export class _POCSAGSingleBaud {
	static SYNC_WORD = 0x7CD215D8 >>> 0;
	static SYNC_INVERTED = (~0x7CD215D8) >>> 0;
	static IDLE_CW = 0x7A89C197 >>> 0;
	// Max Hamming distance to still recognise a sync / idle word
	static SYNC_TOLERANCE = 2;

	static _ecc: ECCTables | null = null;

	audioRate: number;
	spb: number;
	baudRate: number;
	onMessage: (msg: POCSAGMessage) => void;

	dcLevel: number;
	dcAlpha: number;
	clockPhase: number;
	lastSample: number;

	shiftReg: number;
	inverted: boolean;
	state: 'hunt' | 'data';

	cwBitCnt: number;
	currentCw: number;
	batchCwIdx: number;

	pageActive: boolean;
	pageCapcode: number;
	pageFunc: number;
	pageBits: number[];

	constructor(audioRate: number, baud: number, onMessage: (msg: POCSAGMessage) => void) {
		this.audioRate = audioRate;
		this.spb = audioRate / baud;   // samples per bit
		this.baudRate = baud;
		this.onMessage = onMessage;

		this.dcLevel = 0;
		this.dcAlpha = 0.001;              // fast initial DC tracking
		this.clockPhase = 0;
		this.lastSample = 0;

		this.shiftReg = 0;
		this.inverted = false;
		this.state = 'hunt';

		this.cwBitCnt = 0;
		this.currentCw = 0;
		this.batchCwIdx = 0;

		this.pageActive = false;
		this.pageCapcode = 0;
		this.pageFunc = 0;
		this.pageBits = [];
	}

	reset(): void {
		this.dcLevel = 0;
		this.clockPhase = 0;
		this.lastSample = 0;
		this.shiftReg = 0;
		this.state = 'hunt';
		this.cwBitCnt = 0;
		this.currentCw = 0;
		this.batchCwIdx = 0;
		this.pageActive = false;
		this.pageBits = [];
	}

	process(samples: Float32Array): void {
		const spb = this.spb;
		const spbHalf = spb * 0.5;

		for (let i = 0; i < samples.length; i++) {
			// Adaptive DC removal — tighten alpha once roughly settled
			this.dcLevel += this.dcAlpha * (samples[i] - this.dcLevel);
			if (this.dcAlpha > 0.0001) this.dcAlpha *= 0.9999;
			const s = samples[i] - this.dcLevel;

			// Zero-crossing PLL: at a bit transition the sample should be at
			// clockPhase ≈ spbHalf (midpoint between bit-sample events).
			// Nudge the clock so transitions land at spbHalf.
			if ((this.lastSample < 0) !== (s < 0)) {
				let err = this.clockPhase - spbHalf;
				// Wrap to [-spbHalf, +spbHalf]
				if (err > spbHalf) err -= spb;
				if (err < -spbHalf) err += spb;
				// Hard-gate: ignore corrections larger than 40% of a bit period
				// (those are glitches, not true bit edges)
				if (Math.abs(err) < spb * 0.40) {
					this.clockPhase -= err * 0.12;
				}
			}
			this.lastSample = s;

			// Sample at the start of each new bit period
			if (++this.clockPhase >= spb) {
				this.clockPhase -= spb;
				this._onBit(s >= 0 ? 1 : 0);
			}
		}
	}

	_onBit(bit: number): void {
		this.shiftReg = ((this.shiftReg << 1) | bit) >>> 0;

		if (this.state === 'hunt') {
			// Accept sync word with up to SYNC_TOLERANCE bit errors
			const dNorm = _pocsagHamming(this.shiftReg, _POCSAGSingleBaud.SYNC_WORD);
			const dInv = _pocsagHamming(this.shiftReg, _POCSAGSingleBaud.SYNC_INVERTED);
			if (dNorm <= _POCSAGSingleBaud.SYNC_TOLERANCE) {
				this.inverted = false;
				this._onSync();
			} else if (dInv <= _POCSAGSingleBaud.SYNC_TOLERANCE) {
				this.inverted = true;
				this._onSync();
			}
		} else {
			// Assemble 32-bit codewords with polarity correction.
			// While doing so, keep watching for a new sync word in case we drift
			// — if we see one mid-batch, re-align immediately.
			const dNorm = _pocsagHamming(this.shiftReg, _POCSAGSingleBaud.SYNC_WORD);
			const dInv = _pocsagHamming(this.shiftReg, _POCSAGSingleBaud.SYNC_INVERTED);
			if (this.cwBitCnt >= 28 && (dNorm <= _POCSAGSingleBaud.SYNC_TOLERANCE || dInv <= _POCSAGSingleBaud.SYNC_TOLERANCE)) {
				// Sync word received as a codeword → new batch starts
				this.inverted = dInv < dNorm;
				this.cwBitCnt = 0;
				this.currentCw = 0;
				this.batchCwIdx = 0;
				return;
			}

			const b = this.inverted ? (1 - bit) : bit;
			this.currentCw = ((this.currentCw << 1) | b) >>> 0;
			if (++this.cwBitCnt === 32) {
				this.cwBitCnt = 0;
				this._onCodeword(this.currentCw);
				this.currentCw = 0;
			}
		}
	}

	_onSync(): void {
		this.state = 'data';
		this.cwBitCnt = 0;
		this.currentCw = 0;
		this.batchCwIdx = 0;
	}

	_onCodeword(cw: number): void {
		// Error-correct the received codeword (mirrors Mayhem: call twice —
		// first call fixes errors, second call counts what remain).
		const pass1 = this._eccCorrect(cw);
		const pass2 = this._eccCorrect(pass1.cw);

		if (pass2.errors >= 3) {
			// Uncorrectable — skip this codeword but keep position counter going
			if (++this.batchCwIdx >= 16) this.state = 'hunt';
			return;
		}

		const corrected = pass2.cw;

		// Exact IDLE check after correction (Mayhem uses exact equality post-ECC)
		if (corrected === _POCSAGSingleBaud.IDLE_CW) {
			if (this.pageActive && this.pageBits.length > 0) this._emitPage();
			this.pageActive = false;
		} else {
			this._processCw(corrected, this.batchCwIdx);
		}

		if (++this.batchCwIdx >= 16) {
			this.state = 'hunt';
		}
	}

	_processCw(cw: number, cwIdx: number): void {
		const type = (cw >>> 31) & 1;
		if (type === 0) {
			// Address codeword → flush any previous page, start new one
			if (this.pageActive && this.pageBits.length > 0) this._emitPage();
			const addrHigh = (cw >>> 13) & 0x3FFFF;
			const func = (cw >>> 11) & 0x3;
			const frame = (cwIdx >> 1) & 0x7;
			this.pageCapcode = (addrHigh << 3) | frame;
			this.pageFunc = func;
			this.pageBits = [];
			this.pageActive = true;
		} else {
			// Message codeword: 20 data bits (bits 30..11), MSB first
			if (this.pageActive) {
				const data = (cw >>> 11) & 0xFFFFF;
				for (let b = 19; b >= 0; b--) {
					this.pageBits.push((data >>> b) & 1);
				}
			}
		}
	}

	/**
	 * BCH(31,21) error correction — ported directly from Mayhem's EccContainer.
	 *
	 * Builds two lookup tables once (shared across all instances via a static
	 * property) then corrects up to 2 bit-errors per codeword, exactly as the
	 * working Mayhem firmware does.  Returns { cw: correctedValue, errors: n }
	 * where n=0 (clean), 1 (1-bit fixed), 2 (2-bit fixed), or 3 (uncorrectable).
	 */

	static _buildECC(): ECCTables {
		const ecs = new Uint32Array(32);
		const bch = new Uint32Array(1025);

		// Generate ECS (error correction sequences) — same LFSR as Mayhem
		let srr = 0x3b4;
		for (let i = 0; i <= 20; i++) {
			ecs[i] = srr;
			if (srr & 1) srr = (srr >>> 1) ^ 0x3b4;
			else srr = srr >>> 1;
		}

		// Two errors in data
		for (let n = 0; n <= 20; n++) {
			for (let i = 0; i <= 20; i++) {
				const k = (ecs[n] ^ ecs[i]) & 0x3FF;
				bch[k] = (i << 5) + n + 0x2000;
			}
		}
		// One error in data
		for (let n = 0; n <= 20; n++) {
			const k = ecs[n] & 0x3FF;
			bch[k] = n + (0x1f << 5) + 0x1000;
		}
		// One error in data + one error in ECC
		for (let n = 0; n <= 20; n++) {
			for (let i = 0; i < 10; i++) {
				const k = (ecs[n] ^ (1 << i)) & 0x3FF;
				bch[k] = n + (0x1f << 5) + 0x2000;
			}
		}
		// One error in ECC only
		for (let n = 0; n < 10; n++) {
			bch[1 << n] = 0x3ff + 0x1000;
		}
		// Two errors in ECC only
		for (let n = 0; n < 10; n++) {
			for (let i = 0; i < 10; i++) {
				if (i !== n) bch[(1 << n) ^ (1 << i)] = 0x3ff + 0x2000;
			}
		}

		return { ecs, bch };
	}

	_eccCorrect(val: number): { cw: number; errors: number } {
		if (!_POCSAGSingleBaud._ecc) _POCSAGSingleBaud._ecc = _POCSAGSingleBaud._buildECC();
		const { ecs, bch } = _POCSAGSingleBaud._ecc;

		// Compute syndrome from data bits (31..11) and received ECC bits (10..1)
		let pari = 0;
		let ecc = 0;
		for (let i = 31; i >= 11; i--) {
			if ((val >>> i) & 1) {
				ecc ^= ecs[31 - i];
				pari ^= 1;
			}
		}

		let acc = 0;
		for (let i = 10; i >= 1; i--) {
			acc = (acc << 1) | ((val >>> i) & 1);
		}
		acc &= 0x3FF;

		const synd = (ecc ^ acc) & 0x3FF;
		let errl = 0;

		if (synd !== 0) {
			const entry = bch[synd];
			if (entry !== 0) {
				const b1 = entry & 0x1f;
				const b2 = (entry >>> 5) & 0x1f;

				if (b2 !== 0x1f) {
					val = (val ^ (1 << (31 - b2))) >>> 0;
					ecc ^= ecs[b2];
				}
				if (b1 !== 0x1f) {
					val = (val ^ (1 << (31 - b1))) >>> 0;
					ecc ^= ecs[b1];
				}

				errl = entry >>> 12;
			} else {
				errl = 3;
			}

			if (errl === 1) pari ^= 1;
		}

		if (errl === 4) errl = 3;

		return { cw: val >>> 0, errors: errl };
	}

	_emitPage(): void {
		const { pageCapcode: capcode, pageFunc: func, pageBits: bits } = this;
		let text = '';

		if (func === 3) {
			// Alphanumeric: 7-bit ASCII, LSB-first per character
			let c = 0, cb = 0;
			for (let i = 0; i < bits.length; i++) {
				c |= (bits[i] << cb);
				if (++cb === 7) {
					if (c >= 32 && c < 127) text += String.fromCharCode(c);
					else if (c === 10 || c === 13) text += '\n';
					c = 0; cb = 0;
				}
			}
		} else if (func !== 0) {
			// Numeric BCD (func 1/2): 4-bit nibbles, LSB-first
			const NMAP = '0123456789 -.)(';
			for (let i = 0; i + 3 < bits.length; i += 4) {
				const n = bits[i] | (bits[i + 1] << 1) | (bits[i + 2] << 2) | (bits[i + 3] << 3);
				if (n < NMAP.length) text += NMAP[n];
			}
		}
		// func === 0 → tone-only

		const clean = text.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/ {2,}/g, ' ').trim();

		if (clean.length > 0 || func === 0) {
			this.onMessage({
				capcode,
				func,
				type: func === 3 ? 'alpha' : (func === 0 ? 'tone' : 'numeric'),
				text: clean,
				baud: this.baudRate,
			});
		}

		this.pageBits = [];
		this.pageActive = false;
	}
}

/** Outer wrapper: runs parallel 1200 Bd and 512 Bd decoders simultaneously. */
export class POCSAGDecoder {
	private _d1200: _POCSAGSingleBaud;
	private _d512: _POCSAGSingleBaud;

	constructor(audioRate: number, onMessage: (msg: POCSAGMessage) => void) {
		this._d1200 = new _POCSAGSingleBaud(audioRate, 1200, onMessage);
		this._d512 = new _POCSAGSingleBaud(audioRate, 512, onMessage);
	}

	process(samples: Float32Array): void {
		this._d1200.process(samples);
		this._d512.process(samples);
	}

	reset(): void {
		this._d1200.reset();
		this._d512.reset();
	}
}
