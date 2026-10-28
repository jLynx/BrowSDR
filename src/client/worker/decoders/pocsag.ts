import type { POCSAGMessage, POCSAGStatus, PocsagMode } from './pocsag.types';
import { POCSAG_CHAR_CORRECTED, POCSAG_CHAR_OK, POCSAG_CHAR_UNCORRECTABLE } from './pocsag.types';
import type { CharsetKey } from './charsets';
import { pocsagCodepage, POCSAG_DEFAULT_CHARSET } from './charsets';
import { FskBitSlicer, BerWindow } from './fsk-frontend';

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

/** Normalise a second-guess candidate string for display: control chars → space,
 * collapse runs of spaces, trim. Uses char codes (no control-char regex). */
function _cleanAltText(text: string): string {
	let out = '';
	let prevSpace = false;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		const ch = code < 0x20 || code === 0x7f ? ' ' : text[i];
		if (ch === ' ') {
			if (prevSpace) continue;
			prevSpace = true;
		} else {
			prevSpace = false;
		}
		out += ch;
	}
	return out.trim();
}

/** Hamming distance between two 32-bit integers. */
export function _pocsagHamming(a: number, b: number): number {
	let x = (a ^ b) >>> 0;
	x -= (x >>> 1) & 0x55555555;
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	x = (x + (x >>> 4)) & 0x0f0f0f0f;
	return Math.imul(x, 0x01010101) >>> 24;
}

/**
 * Even parity over all 32 bits of a POCSAG codeword. Bit 0 is the overall
 * even-parity bit covering bits 31..1, so a well-formed codeword has an EVEN
 * popcount → returns 0.
 */
export function _pocsagParity(word: number): number {
	let x = word >>> 0;
	x ^= x >>> 16;
	x ^= x >>> 8;
	x ^= x >>> 4;
	x ^= x >>> 2;
	x ^= x >>> 1;
	return x & 1;
}

/**
 * BCH(31,21) syndrome for a POCSAG codeword, with the overall even-parity bit
 * folded in as the 11th syndrome bit (bit 10). Divides the 21 data bits by the
 * generator polynomial 0x769, then OR-s parity into bit 10. A well-formed
 * codeword (correct BCH remainder AND even parity) yields 0. A correction is
 * valid only when it drives THIS value to 0, i.e. the corrected word satisfies
 * the CRC remainder AND parity together.
 */
export function _pocsagSyndrome(word: number): number {
	let s = (word >>> 1) & 0x7fffffff; // drop parity bit, keep 31-bit codeword
	let mask = 1 << 30;
	let coeff = (0x769 << 20) >>> 0;
	for (let i = 21; i > 0; i--) {
		if (s & mask) s ^= coeff;
		mask >>>= 1;
		coeff >>>= 1;
	}
	s &= 0x3ff;
	if (_pocsagParity(word)) s |= 1 << 10;
	return s >>> 0;
}

export class _POCSAGSingleBaud {
	static SYNC_WORD = 0x7cd215d8 >>> 0;
	static SYNC_INVERTED = ~0x7cd215d8 >>> 0;
	static IDLE_CW = 0x7a89c197 >>> 0;
	// Max Hamming distance to still recognise a sync / idle word
	static SYNC_TOLERANCE = 2;
	// Bits to search for the next frame sync codeword (FSC) after a batch ends
	// before concluding the transmission stopped and returning to hunt.
	// Tolerates bit slip without missing a new preamble at any baud.
	static RESYNC_TIMEOUT_BITS = 48;
	// ITU-R M.584-2 §2.5.1: a pager ceases decoding a message after TWO
	// successive indecipherable (uncorrectable) information codewords — end the
	// message there, but stay in sync (the next idle/address still delimits).
	static MSG_END_BAD_CODEWORDS = 2;
	// ITU-R M.584-2 §2.3: a longer unbroken run of uncorrectable codewords means
	// synchronisation itself is lost (not just one bad message) — drop to hunt
	// and re-acquire. The standard sets no exact count; half a batch of pure
	// garbage is a conservative "the lock is dead" threshold.
	static SYNC_LOSS_BAD_CODEWORDS = 8;
	// Alternating preamble bits required to accept a BCH-corrected (1-2 bit
	// error) sync; an exact (0-error) sync is accepted without preamble.
	static MIN_PREAMBLE_BITS = 8;
	// Max mid-symbol crossings (nonconsec) tolerated at a sync candidate. A
	// wrong-baud signal exceeds this (crossings land mid-symbol); the correct
	// rate keeps it ~0.
	static NONCONSEC_MAX_SYNC = 10;

	baudRate: number;
	onMessage: (msg: POCSAGMessage) => void;

	/** Shared NFM/2-FSK bit recovery (DC removal + timing PLL + bit slicing). */
	slicer: FskBitSlicer;
	/** nonconsec/pllLocked are owned by the slicer; expose them so the sync
	 * logic below reads/sets them exactly as before. */
	get nonconsec(): number {
		return this.slicer.nonconsec;
	}
	set nonconsec(v: number) {
		this.slicer.nonconsec = v;
	}
	get pllLocked(): boolean {
		return this.slicer.pllLocked;
	}
	set pllLocked(v: boolean) {
		this.slicer.pllLocked = v;
	}
	/** Upper 32 bits of the 64-bit RX window (bits above the sync in shiftReg),
	 * used to measure the alternating preamble that precedes a sync word. */
	shiftRegHi: number;

	shiftReg: number;
	inverted: boolean;
	state: 'hunt' | 'data';
	// FSC-search lock model:
	//   batchRemain     — data codewords left in the current batch (16→0)
	//   resyncCountdown — bits left to find the next FSC after a batch (→unlock)
	//   resyncBits      — bits consumed in the current between-batch FSC search
	batchRemain: number;
	resyncCountdown: number;
	resyncBits: number;

	cwBitCnt: number;
	currentCw: number;
	batchCwIdx: number;
	// A corrected (1-2 bit) sync accepted WITHOUT a preceding alternating
	// preamble (i.e. joining an ongoing transmission mid-stream, where the
	// preamble is long past) is only PROVISIONAL: the first codeword after it
	// must decode (BCH errors < 3) to confirm the lock, otherwise it was a
	// noise false-lock and we drop back to hunt. An exact sync, or a corrected
	// sync with preamble, is a confirmed lock (provisional === false).
	provisional: boolean;
	// Consecutive uncorrectable codewords while locked (ITU-R M.584-2 §2.5.1 /
	// §2.3): drives end-of-message and full sync-loss. Reset by any correctable
	// codeword.
	consecBad: number;

	pageActive: boolean;
	pageCapcode: number;
	pageFunc: number;
	pageBits: number[];
	// Per-bit decode status parallel to pageBits: 0=ok, 1=corrected, 2=bad.
	pageBitStatus: number[];

	// Rolling bit-error rate over the most recent window of decoded codewords
	// (BCH-corrected bits / payload bits), via the shared decaying-window
	// accumulator.
	ber: BerWindow = new BerWindow();

	// Selected codepage key (protocol-implied: pocsag). Decides which glyph
	// table _decodeAlpha uses. Defaults to generic ASCII.
	charset: CharsetKey;
	// Type-detection mode: 'auto' = content heuristic picks alpha/numeric;
	// 'alpha'/'numeric' = force that decode. Default 'auto'.
	mode: PocsagMode;
	// When true (and mode='auto'), also emit the runner-up interpretation as
	// `alt` on the message so the UI can show a dim second guess.
	showSecondGuess: boolean;

	constructor(audioRate: number, baud: number, onMessage: (msg: POCSAGMessage) => void, charset: CharsetKey = POCSAG_DEFAULT_CHARSET) {
		this.baudRate = baud;
		this.onMessage = onMessage;
		this.charset = charset;
		this.mode = 'auto';
		this.showSecondGuess = false;

		// Shared NFM/2-FSK bit recovery (DC removal + timing PLL + bit slicing).
		this.slicer = new FskBitSlicer(audioRate, baud, (bit) => this._onBit(bit));
		this.shiftRegHi = 0;

		this.shiftReg = 0;
		this.inverted = false;
		this.state = 'hunt';
		this.batchRemain = 0;
		this.resyncCountdown = 0;
		this.resyncBits = 0;

		this.cwBitCnt = 0;
		this.currentCw = 0;
		this.batchCwIdx = 0;
		this.provisional = false;
		this.consecBad = 0;

		this.pageActive = false;
		this.pageCapcode = 0;
		this.pageFunc = 0;
		this.pageBits = [];
		this.pageBitStatus = [];
	}

	reset(): void {
		this.slicer.reset();
		this.ber.reset();
		this.shiftRegHi = 0;
		this.shiftReg = 0;
		this.state = 'hunt';
		this.batchRemain = 0;
		this.resyncCountdown = 0;
		this.resyncBits = 0;
		this.cwBitCnt = 0;
		this.currentCw = 0;
		this.batchCwIdx = 0;
		this.provisional = false;
		this.consecBad = 0;
		this.pageActive = false;
		this.pageBits = [];
		this.pageBitStatus = [];
	}

	process(samples: Float32Array): void {
		this.slicer.process(samples);
	}

	/**
	 * Count the alternating-preamble bits immediately preceding the sync word.
	 * shiftRegHi holds the 32 bits above the sync window; the preamble (…1010…)
	 * sits in its low bits. Count upward from bit 0 while adjacent bits alternate.
	 * Returns 0..32 (32 means "at least a full window of preamble").
	 */
	_preambleBefore(): number {
		const w = this.shiftRegHi >>> 0;
		let count = 0;
		let prev = w & 1;
		for (let i = 1; i < 32; i++) {
			const b = (w >>> i) & 1;
			if (b !== prev) {
				count++;
				prev = b;
			} else {
				break;
			}
		}
		return count;
	}

	_onBit(bit: number): void {
		// Maintain a 64-bit receive window: shiftRegHi holds bits 32..63 (the
		// bits ABOVE the 32-bit sync window in shiftReg). Carry shiftReg's
		// outgoing MSB into shiftRegHi's LSB so preamble preceding the sync can
		// be measured without the sync word's own bits corrupting the count.
		this.shiftRegHi = ((this.shiftRegHi << 1) | ((this.shiftReg >>> 31) & 1)) >>> 0;
		this.shiftReg = ((this.shiftReg << 1) | bit) >>> 0;

		if (this.state === 'hunt') {
			// Not locked: bit-by-bit search for the frame sync codeword (FSC).
			// Per the standard a transmission ALWAYS precedes sync with a long
			// alternating preamble, so require preamble before accepting a cold
			// lock — this is what rejects wrong-baud / noise false-locks. The
			// preamble is counted in the UPPER bits of a 64-bit window (above the
			// 32-bit sync), so the sync word's own bits don't reset the count.
			const dNorm = _pocsagHamming(this.shiftReg, _POCSAGSingleBaud.SYNC_WORD);
			const dInv = _pocsagHamming(this.shiftReg, _POCSAGSingleBaud.SYNC_INVERTED);
			// Acceptance tiers:
			//   • EXACT match (0 bit errors): accept immediately, confirmed — a
			//     full 32-bit sync is decisive on its own.
			//   • CORRECTED (1-2 bit errors) WITH preamble: confirmed lock — the
			//     alternating preamble before the sync is strong corroboration.
			//   • CORRECTED (1-2 bit errors) WITHOUT preamble but with good PLL
			//     timing: accept PROVISIONALLY. Requiring preamble here would
			//     reject every mid-transmission join, because batches after the
			//     first carry no preamble before their FSC. The lock is confirmed
			//     by the first following codeword decoding (see _onCodeword); a
			//     noise false-lock produces an uncorrectable first codeword and is
			//     dropped. The timing gate (low nonconsec) still rejects
			//     wrong-baud candidates up front.
			const preOk = this._preambleBefore() >= _POCSAGSingleBaud.MIN_PREAMBLE_BITS;
			const timingOk = this.nonconsec < _POCSAGSingleBaud.NONCONSEC_MAX_SYNC;
			// Returns 'no' (reject), 'confirmed' (lock) or 'provisional' (lock,
			// pending first-codeword confirmation).
			const classify = (d: number): 'no' | 'confirmed' | 'provisional' => {
				if (d === 0) return 'confirmed';
				if (d > _POCSAGSingleBaud.SYNC_TOLERANCE || !timingOk) return 'no';
				return preOk ? 'confirmed' : 'provisional';
			};
			const vNorm = classify(dNorm);
			if (vNorm !== 'no') {
				this.inverted = false;
				this.pllLocked = true;
				this._onSync(vNorm === 'provisional');
				return;
			}
			const vInv = classify(dInv);
			if (vInv !== 'no') {
				this.inverted = true;
				this.pllLocked = true;
				this._onSync(vInv === 'provisional');
			}
			return;
		}

		// ── LOCKED ──────────────────────────────────────────────────────────
		if (this.batchRemain > 0) {
			// Inside a batch: accumulate 32-bit codewords by frame count.
			this.currentCw = ((this.currentCw << 1) | bit) >>> 0;
			if (++this.cwBitCnt < 32) return;
			this.cwBitCnt = 0;
			const raw = this.currentCw >>> 0;
			this.currentCw = 0;
			const cw = this.inverted ? ~raw >>> 0 : raw;
			this._onCodeword(cw);
			if (--this.batchRemain === 0) {
				// Batch complete. Per POCSAG spec the next FSC follows the last
				// codeword with (near) zero gap, but we search a short window to
				// tolerate bit slip / clock drift instead of assuming an exact
				// position. Enter between-batch FSC search.
				this.resyncCountdown = _POCSAGSingleBaud.RESYNC_TIMEOUT_BITS;
				this.resyncBits = 0;
				// Clear the shift register so the FSC search starts from a
				// known-empty window. Without this, any mid-batch bit-slip
				// (one extra or missing bit anywhere in the 16 codewords) leaves
				// a slipped bit in shiftReg that acts as the FSC's first bit,
				// causing resyncBits=31 and misframing the entire next batch.
				this.shiftReg = 0;
				this.shiftRegHi = 0;
			}
			return;
		}

		// Between batches: search bit-by-bit for the next FSC within the window.
		this._fscSearch();
	}

	/** Between-batch FSC search (locked). Re-locks on sync, unlocks on timeout
	 * or on a valid non-sync codeword (signal changed).
	 *
	 * A candidate window is accepted as the FSC only when it BCH-corrects to
	 * EXACTLY the sync word. A bare Hamming-distance check is not sufficient:
	 * one bit before the true boundary the window [last data bit | 31 FSC bits]
	 * can sit within Hamming distance 2 yet NOT be a BCH-valid correction to the
	 * sync word. Accepting it re-locks one bit early, shifting the entire batch
	 * by one bit and producing phantom codewords that BCH force-corrects into
	 * garbage messages. */
	_fscSearch(): void {
		this.resyncBits++;
		const w = this.shiftReg >>> 0;

		// Accept only if BCH correction produces exactly the sync word.
		const curTarget = this.inverted ? _POCSAGSingleBaud.SYNC_INVERTED : _POCSAGSingleBaud.SYNC_WORD;
		if (_pocsagHamming(w, curTarget) <= _POCSAGSingleBaud.SYNC_TOLERANCE) {
			const trial = (this.inverted ? ~w : w) >>> 0;
			const r = this._eccCorrect(trial);
			if (r.errors < 3 && r.cw >>> 0 === _POCSAGSingleBaud.SYNC_WORD) {
				this._onSync();
				return;
			}
		}

		// Opposite-polarity FSC → genuine polarity flip at the batch boundary
		// (the ONLY place polarity may legitimately change). Same BCH-to-SYNC
		// gate as above, against the opposite polarity.
		const othTarget = this.inverted ? _POCSAGSingleBaud.SYNC_WORD : _POCSAGSingleBaud.SYNC_INVERTED;
		if (_pocsagHamming(w, othTarget) <= _POCSAGSingleBaud.SYNC_TOLERANCE) {
			const trial = (this.inverted ? w : ~w) >>> 0;
			const r = this._eccCorrect(trial);
			if (r.errors < 3 && r.cw >>> 0 === _POCSAGSingleBaud.SYNC_WORD) {
				this.inverted = !this.inverted;
				this._onSync();
				return;
			}
		}

		// Frame-level sanity: once a full 32-bit window has passed during the
		// search, if it BCH-corrects to a VALID non-sync codeword the signal has
		// changed (new/ended transmission) — unlock rather than emit garbage.
		// EXCEPTION: while a page is active (a message is mid-assembly), a valid
		// non-IDLE codeword at the batch boundary is IN-TRANSMISSION CONTENT, not
		// a signal change. Unlocking here drops lock the instant real message
		// content follows the address, fragmenting the page across locks so the
		// text is discarded and never emitted. Only treat a valid codeword as a
		// changed signal when NO page is open.
		if (this.resyncBits >= 32 && !this.pageActive) {
			const trial = this.inverted ? ~w >>> 0 : w;
			const r = this._eccCorrect(trial);
			if (r.errors < 3 && r.cw !== _POCSAGSingleBaud.IDLE_CW) {
				this._unlock();
				return;
			}
		}

		if (this.resyncCountdown > 0 && --this.resyncCountdown === 0) {
			// No FSC within the window — transmission ended; back to hunt.
			this._unlock();
		}
	}

	/** Flush any open page and drop to hunt. */
	_unlock(): void {
		if (this.pageActive && this.pageBits.length > 0) this._emitPage();
		this.pageActive = false;
		this.state = 'hunt';
		this.batchRemain = 0;
		this.resyncCountdown = 0;
		this.resyncBits = 0;
		this.cwBitCnt = 0;
		this.currentCw = 0;
		this.shiftReg = 0;
		this.shiftRegHi = 0;
		this.provisional = false;
		// Reset BER window so hunt state reports null (no stale data from last lock).
		this.ber.reset();
	}

	_onSync(provisional = false): void {
		// Sync acquired (or re-acquired at a batch boundary). A batch is 16 data
		// codewords; count them down, then search for the next FSC.
		this.state = 'data';
		this.batchRemain = 16;
		this.resyncCountdown = 0;
		this.resyncBits = 0;
		this.cwBitCnt = 0;
		this.currentCw = 0;
		this.batchCwIdx = 0;
		// Clear the shift register so the between-batch FSC search starts from a
		// known-empty window. Without this the last bit of CW#15 (or the FSC
		// itself) remains in shiftReg, and the next FSC can match after only 31
		// bits (the stale bit acts as the FSC's first bit), causing a one-bit
		// misalignment that shifts the entire following batch.
		this.shiftReg = 0;
		this.shiftRegHi = 0;
		// Re-anchor the bit-recovery clock to this verified FSC boundary so the
		// new batch's 16-codeword grid is pinned to the sync, not carried on a
		// possibly-slipped free-running phase from the previous batch. The FSC's
		// final bit (the bit that just triggered this callback) is a true symbol
		// boundary, so resetting the slicer phase here keeps framing aligned even
		// if a one-bit timing slip occurred during the preceding batch.
		this.slicer.syncPhase();
		// A provisional lock (corrected sync, no preamble) awaits confirmation
		// from the first codeword. A batch-boundary resync of an already-open
		// page is a confirmed lock (we were already decoding valid codewords).
		this.provisional = provisional && !this.pageActive;
		// Preserve the uncorrectable run ACROSS a batch boundary while a message
		// is still open: an uncorrectable last information word in one batch
		// followed by an uncorrectable first information word in the next must
		// still trip the two-bad-codeword end-of-message policy (ITU-R M.584-2
		// §2.5.1). Only a COLD lock from hunt (no page active) starts fresh.
		if (!this.pageActive) this.consecBad = 0;
	}

	_onCodeword(cw: number): void {
		// Parity-aware BCH correction. A single pass fully
		// corrects (≤2 bits) or reports uncorrectable (errors === 3); no second
		// confirmation pass is needed.
		const result = this._eccCorrect(cw);
		const errors = result.errors;
		const corrected = result.cw;

		// Confirm or reject a PROVISIONAL lock (corrected sync accepted without a
		// preamble, e.g. a mid-transmission join). The first codeword decides: a
		// decodable word (errors < 3) corroborates the sync and confirms the
		// lock; an uncorrectable word means the "sync" was a noise coincidence —
		// drop back to hunt WITHOUT emitting anything, so the false-lock
		// protection the preamble gate used to provide is retained.
		if (this.provisional) {
			if (errors >= 3) {
				this._unlock();
				return;
			}
			this.provisional = false;
		}

		// Accumulate bit-error stats over a decaying window. errors is 0/1/2 for
		// corrected codewords, 3 for uncorrectable (capped). 31 payload bits per
		// codeword.
		this.ber.add(Math.min(errors, 3), 31);

		if (errors >= 3) {
			this.consecBad++;
			// ITU-R M.584-2 §2.3: a long unbroken run of uncorrectable codewords
			// means sync itself is lost — drop to hunt (flushing any open page)
			// and re-acquire on the next preamble/sync. Checked first so a dead
			// signal doesn't keep manufacturing '?' for the rest of the batch.
			if (this.consecBad >= _POCSAGSingleBaud.SYNC_LOSS_BAD_CODEWORDS) {
				this._unlock();
				this.batchCwIdx++;
				return;
			}
			// ITU-R M.584-2 §2.5.1: cease decoding the CURRENT message after two
			// successive indecipherable information codewords — emit what we have
			// and close the page, but STAY locked (the next idle/address codeword
			// still delimits the following message within this batch).
			if (this.pageActive && this.consecBad >= _POCSAGSingleBaud.MSG_END_BAD_CODEWORDS) {
				if (this.pageBits.length > 0) this._emitPage();
				this.pageActive = false;
				this.batchCwIdx++;
				return;
			}
			// First bad codeword of a (possibly transient) run: keep bit alignment
			// by appending 20 placeholder bits marked uncorrectable (status 2);
			// _emitPage renders them as '?'. A single glitch followed by good
			// content is thus preserved as a short '?' span.
			if (this.pageActive) {
				for (let b = 0; b < 20; b++) {
					this.pageBits.push(0);
					this.pageBitStatus.push(POCSAG_CHAR_UNCORRECTABLE);
				}
			}
			this.batchCwIdx++;
			return;
		}
		// Any decipherable codeword resets the consecutive-bad run (§2.5.1/§2.3).
		this.consecBad = 0;

		// Status for this codeword's contributed bits: 0 clean, 1 BCH-corrected.
		const bitStatus = errors > 0 ? POCSAG_CHAR_CORRECTED : POCSAG_CHAR_OK;

		// Exact IDLE check after correction (exact equality post-ECC).
		if (corrected === _POCSAGSingleBaud.IDLE_CW) {
			if (this.pageActive && this.pageBits.length > 0) this._emitPage();
			this.pageActive = false;
		} else {
			this._processCw(corrected, this.batchCwIdx, bitStatus);
		}

		// Advance frame position. At batchCwIdx === 16 the next 32 bits are the
		// batch-boundary sync, handled by _onBit's hysteresis — we stay locked.
		this.batchCwIdx++;
	}

	/** Population count of a 32-bit value. */
	_popcount32(v: number): number {
		let x = v >>> 0;
		x -= (x >>> 1) & 0x55555555;
		x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
		x = (x + (x >>> 4)) & 0x0f0f0f0f;
		return Math.imul(x, 0x01010101) >>> 24;
	}

	_processCw(cw: number, cwIdx: number, bitStatus: number): void {
		const type = (cw >>> 31) & 1;
		if (type === 0) {
			// Address codeword → flush any previous page, start new one
			if (this.pageActive && this.pageBits.length > 0) this._emitPage();
			const addrHigh = (cw >>> 13) & 0x3ffff;
			const func = (cw >>> 11) & 0x3;
			const frame = (cwIdx >> 1) & 0x7;
			this.pageCapcode = (addrHigh << 3) | frame;
			this.pageFunc = func;
			this.pageBits = [];
			this.pageBitStatus = [];
			this.pageActive = true;
		} else {
			// Message codeword: 20 data bits (bits 30..11), MSB first. Each bit
			// inherits this codeword's status so _emitPage can mark the character
			// it lands in as clean / corrected / uncorrectable.
			if (this.pageActive) {
				const data = (cw >>> 11) & 0xfffff;
				for (let b = 19; b >= 0; b--) {
					this.pageBits.push((data >>> b) & 1);
					this.pageBitStatus.push(bitStatus);
				}
			}
		}
	}

	/**
	 * Parity-aware BCH(31,21) correction.
	 * Returns { cw, errors } where errors = 0 (clean), 1 or 2 (bits corrected to
	 * a word satisfying BCH remainder AND parity), or 3 (uncorrectable).
	 */

	_eccCorrect(val: number): { cw: number; errors: number } {
		// Parity-aware BCH(31,21) correction.
		// A word is accepted ONLY when a flip of ≤2 bits drives the FULL syndrome
		// (BCH remainder AND the folded even-parity bit) to zero — the corrected
		// word must satisfy the CRC remainder and parity SIMULTANEOUSLY. This is
		// stricter than a bare "distance ≤ 2 to any codeword" table lookup: it
		// rejects the ~half of near-codeword noise windows that would land on the
		// wrong parity, which is the main source of phantom codewords.
		const word = val >>> 0;
		if (_pocsagSyndrome(word) === 0) return { cw: word, errors: 0 };

		// Try every single-bit flip.
		for (let i = 0; i < 32; i++) {
			const trial = (word ^ (1 << i)) >>> 0;
			if (_pocsagSyndrome(trial) === 0) return { cw: trial, errors: 1 };
		}
		// Try every two-bit flip combination.
		for (let i = 0; i < 32; i++) {
			for (let j = i + 1; j < 32; j++) {
				const trial = (word ^ (1 << i) ^ (1 << j)) >>> 0;
				if (_pocsagSyndrome(trial) === 0) return { cw: trial, errors: 2 };
			}
		}
		return { cw: word, errors: 3 }; // uncorrectable (3+ bit errors)
	}

	/**
	 * Decode the page bit buffer as 7-bit alphanumeric (ITU IA5, LSB-first per
	 * character), mapping each code through the active codepage so vendor /
	 * national glyphs (umlauts, Cyrillic, …) render correctly. Per-character
	 * status is the worst status among the 7 source bits; unmapped codes and
	 * uncorrectable spans become the lost-char sentinel.
	 */
	_decodeAlpha(bits: number[], status: number[]): { text: string; charStatus: number[] } {
		const cp = pocsagCodepage(this.charset);
		const chars: string[] = [];
		const rawCodes: number[] = []; // raw 7-bit code parallel to chars[], for padding detection
		const charStatus: number[] = [];
		let c = 0;
		let cb = 0;
		let worst = POCSAG_CHAR_OK;
		for (let i = 0; i < bits.length; i++) {
			c |= bits[i] << cb;
			if (status[i] > worst) worst = status[i];
			if (++cb === 7) {
				let ch: string;
				const raw = c & 0x7f;
				const glyph = cp[raw];
				if (worst === POCSAG_CHAR_UNCORRECTABLE)
					ch = '\ufffd'; // lost data
				else if (c === 0)
					ch = '\u0000'; // NULL = end-of-message fill
				else if (glyph != null)
					ch = glyph; // mapped glyph (incl. \n, \r)
				else ch = String.fromCharCode(c); // other control/unmapped — keep raw for <0xNN> display
				chars.push(ch);
				rawCodes.push(raw);
				charStatus.push(worst);
				c = 0;
				cb = 0;
				worst = POCSAG_CHAR_OK;
			}
		}
		// Strip trailing fill. Per POCSAG spec §4.2, padding is the last 1 or 2
		// chars of the last codeword, filled with the same character.
		// Step 1: NUL (0x00) — always padding, check first unconditionally.
		// Step 2: if not NUL-padded, check if the last char is non-printable
		//         (cp[code]===null); if so, strip 1 or 2 of that same code.
		let end = chars.length;
		if (end > 0 && rawCodes[end - 1] === 0x00) {
			end--;
			if (end > 0 && rawCodes[end - 1] === 0x00) end--;
		} else if (end > 0 && chars[end - 1] !== '\ufffd' && cp[rawCodes[end - 1]] === null) {
			const padCode = rawCodes[end - 1];
			end--;
			if (end > 0 && rawCodes[end - 1] === padCode) end--;
		}
		// Also drop any embedded NULLs (incomplete fill at codeword boundaries).
		let text = '';
		const outStatus: number[] = [];
		for (let i = 0; i < end; i++) {
			if (chars[i] === '\u0000') continue;
			text += chars[i];
			outStatus.push(charStatus[i]);
		}
		return { text, charStatus: outStatus };
	}

	/**
	 * Decode the page bit buffer as numeric BCD (4-bit nibbles). Each digit's
	 * bits are sent MSB-first on air; we accumulate them LSB-first here (the
	 * same bit-reversal the reference decoders apply), then index the standard
	 * POCSAG numeric table (ITU-R M.584 / RPC1):
	 * 10='R' 11='U' 12=space 13='-' 14=']'
	 * 15='['. Per-nibble status is the worst of its 4 source bits.
	 */
	_decodeNumeric(bits: number[], status: number[]): { text: string; charStatus: number[] } {
		const NMAP = '0123456789RU -][';
		let text = '';
		const charStatus: number[] = [];
		for (let i = 0; i + 3 < bits.length; i += 4) {
			const n = bits[i] | (bits[i + 1] << 1) | (bits[i + 2] << 2) | (bits[i + 3] << 3);
			let worst = POCSAG_CHAR_OK;
			for (let b = 0; b < 4; b++) if (status[i + b] > worst) worst = status[i + b];
			text += worst === POCSAG_CHAR_UNCORRECTABLE ? '\ufffd' : NMAP[n];
			charStatus.push(worst);
		}
		return { text, charStatus };
	}

	/**
	 * Quality of a decoded candidate in [0,1]: the fraction of characters that
	 * read as sensible content for that encoding. BrowSDR must choose ONE type
	 * (one decoder output is chosen rather than listing every interpretation),
	 * so we compare normalized quality: an alpha page decoded as numeric
	 * sprays the rare R U ] [ symbols (low numeric quality), and a numeric page
	 * decoded as alpha yields control codes (low alpha quality).
	 */
	_scoreCandidate(text: string, kind: 'alpha' | 'numeric'): number {
		if (text.length === 0) return 0;
		let good = 0;
		for (let i = 0; i < text.length; i++) {
			const ch = text.charCodeAt(i);
			if (ch === 0xfffd) continue; // lost char
			if (kind === 'numeric') {
				// Digits / space / '-' are strong numeric content; the rare
				// symbols R U ] [ count half so an alpha-as-numeric scores lower.
				if ((ch >= 0x30 && ch <= 0x39) || ch === 0x20 || ch === 0x2d) good += 1;
				else good += 0.5;
			} else {
				// Alpha quality. A real alpha page is letters, digits, spaces and
				// ordinary punctuation. Control characters (below 0x20, other than
				// newline/CR) are the tell-tale of a NON-alpha page misread as
				// alpha — penalise them HARD so numeric wins those. Newline/CR and
				// everyday printable punctuation count as content.
				if (ch < 0x20) {
					if (ch === 10 || ch === 13)
						good += 1; // newline/CR are legit
					else good -= 1; // control char: strong evidence this isn't alpha
				} else {
					good += 1; // any printable glyph (ASCII or codepage)
				}
			}
		}
		return Math.max(0, good) / text.length;
	}

	/**
	 * Choose the message type and decode it. In 'auto' mode a content heuristic
	 * picks alpha vs numeric (the function field is a sub-address, not a reliable
	 * encoding indicator); 'alpha'/'numeric' force the decode. Returns the chosen
	 * type, its decode, the detection-score string, and (auto + second-guess) the
	 * runner-up interpretation.
	 */
	_decidePage(
		func: number,
		bits: number[],
		status: number[],
	): {
		chosen: 'alpha' | 'tone' | 'numeric';
		decoded: { text: string; charStatus: number[] };
		detectScores: string;
		altGuess?: { type: 'alpha' | 'numeric'; text: string };
	} {
		if (func === 0 && bits.length === 0) {
			return { chosen: 'tone', decoded: { text: '', charStatus: [] }, detectScores: '' };
		}
		const alpha = this._decodeAlpha(bits, status);
		const numeric = this._decodeNumeric(bits, status);
		if (this.mode === 'alpha') return { chosen: 'alpha', decoded: alpha, detectScores: '' };
		if (this.mode === 'numeric') return { chosen: 'numeric', decoded: numeric, detectScores: '' };
		// Auto heuristic.
		const alphaQ = this._scoreCandidate(alpha.text, 'alpha');
		const numericQ = this._scoreCandidate(numeric.text, 'numeric');
		const numericIsPureDigits = numeric.text.length > 0 && /^[0-9 -]+$/.test(numeric.text);
		// A clean alpha reading is one with no control characters — i.e. every
		// character is legitimate alpha content (alphaQ === 1). When the alpha
		// reading is clean AND the numeric reading is pure digits, the page is
		// genuinely ambiguous: both interpretations are plausible (a short alpha
		// page such as "A"/"AB"/"12345" also reads as digits). Numeric must NOT
		// win that tie — doing so turns independently-encoded alpha pages into
		// numeric gibberish while forced-Alpha recovers the original. Prefer
		// alpha on the tie (it preserves the content and matches main /
		// forced-Alpha) and require numeric to score STRICTLY higher to win.
		const alphaIsClean = alpha.text.length > 0 && alphaQ >= 1;
		const ambiguous = alphaIsClean && numericIsPureDigits;
		let chosen: 'alpha' | 'numeric';
		if (numericIsPureDigits && numericQ > alphaQ) chosen = 'numeric';
		else if (alphaQ >= 0.8 || alphaQ + 0.1 >= numericQ) chosen = 'alpha';
		else chosen = 'numeric';
		const detectScores = `a=${alphaQ.toFixed(2)} n=${numericQ.toFixed(2)}`;
		// Surface the runner-up interpretation when the user asked for it OR when
		// the page is genuinely ambiguous — so a tied reading is never silently
		// hidden behind the default pick.
		const showAlt = this.showSecondGuess || ambiguous;
		const altGuess = showAlt
			? chosen === 'alpha'
				? { type: 'numeric' as const, text: numeric.text }
				: { type: 'alpha' as const, text: alpha.text }
			: undefined;
		return { chosen, decoded: chosen === 'alpha' ? alpha : numeric, detectScores, altGuess };
	}

	_emitPage(): void {
		const { pageCapcode: capcode, pageFunc: func, pageBits: bits, pageBitStatus: status } = this;

		const { chosen, decoded, detectScores, altGuess } = this._decidePage(func, bits, status);

		// Collapse runs of whitespace for the displayed text while keeping a
		// per-character status parallel to the FINAL text. We rebuild both in
		// lock-step so colour-coding lines up with the trimmed string. Trailing
		// uncorrectable ('?') spans are PRESERVED — they are the signal that the
		// message was truncated by lost data (incomplete reception), not noise to
		// hide.
		const outChars: string[] = [];
		const outStatus: number[] = [];
		let prevSpace = false;
		for (let i = 0; i < decoded.text.length; i++) {
			let ch = decoded.text[i];
			const code = ch.charCodeAt(0);
			// Map the internal lost-char sentinel (U+FFFD) to a plain '?' for
			// display. Control characters (newline, etc.) are PRESERVED in the
			// emitted text — the log/display layer represents them (⏎ for newline,
			// <0xNN> for others) rather than flattening them here.
			if (code === 0xfffd) ch = '?';
			if (ch === ' ') {
				if (prevSpace) continue; // collapse consecutive spaces
				prevSpace = true;
			} else {
				prevSpace = false;
			}
			outChars.push(ch);
			outStatus.push(decoded.charStatus[i] ?? POCSAG_CHAR_OK);
		}
		// Trim leading/trailing spaces, keeping status aligned.
		while (outChars.length && outChars[0] === ' ') {
			outChars.shift();
			outStatus.shift();
		}
		while (outChars.length && outChars[outChars.length - 1] === ' ') {
			outChars.pop();
			outStatus.pop();
		}

		const clean = outChars.join('');

		if (clean.length > 0 || chosen === 'tone') {
			this.onMessage({
				capcode,
				func,
				type: chosen,
				text: clean,
				charStatus: outStatus,
				baud: this.baudRate,
				inverted: this.inverted,
				detectDebug: detectScores || undefined,
				alt: altGuess ? { type: altGuess.type, text: _cleanAltText(altGuess.text) } : undefined,
			});
		}

		this.pageBits = [];
		this.pageBitStatus = [];
		this.pageActive = false;
	}

	/** Snapshot of this sub-decoder's link status. */
	getStatus(): POCSAGStatus {
		const synced = this.state === 'data';
		return {
			synced,
			baud: synced ? this.baudRate : null,
			inverted: this.inverted,
			ber: this.ber.ber,
			codewords: this.ber.count,
			stage: synced ? (this.pageActive ? 'page' : 'batch') : null,
		};
	}
}

/** Outer wrapper: runs parallel 512 / 1200 / 2400 Bd decoders simultaneously. */
export class POCSAGDecoder {
	private _d2400: _POCSAGSingleBaud;
	private _d1200: _POCSAGSingleBaud;
	private _d512: _POCSAGSingleBaud;

	constructor(audioRate: number, onMessage: (msg: POCSAGMessage) => void, charset: CharsetKey = POCSAG_DEFAULT_CHARSET) {
		// POCSAG is standardised at 512 / 1200 / 2400 Bd (ITU-R M.584).
		this._d2400 = new _POCSAGSingleBaud(audioRate, 2400, onMessage, charset);
		this._d1200 = new _POCSAGSingleBaud(audioRate, 1200, onMessage, charset);
		this._d512 = new _POCSAGSingleBaud(audioRate, 512, onMessage, charset);
	}

	/** Change the active codepage for all baud sub-decoders. */
	setCharset(charset: CharsetKey): void {
		this._d2400.charset = charset;
		this._d1200.charset = charset;
		this._d512.charset = charset;
	}

	/** Set the type-detection mode (auto / alpha / numeric) for all rates. */
	setMode(mode: PocsagMode): void {
		this._d2400.mode = mode;
		this._d1200.mode = mode;
		this._d512.mode = mode;
	}

	/** Toggle emitting the runner-up interpretation (auto mode) for all rates. */
	setShowSecondGuess(on: boolean): void {
		this._d2400.showSecondGuess = on;
		this._d1200.showSecondGuess = on;
		this._d512.showSecondGuess = on;
	}

	process(samples: Float32Array): void {
		this._d2400.process(samples);
		this._d1200.process(samples);
		this._d512.process(samples);
	}

	reset(): void {
		this._d2400.reset();
		this._d1200.reset();
		this._d512.reset();
	}

	/**
	 * Combined link status across the three baud sub-decoders. If one is locked
	 * (synced), its status wins; otherwise the sub-decoder with the most recent
	 * bit-error evidence (most codewords seen) is reported, so the UI shows the
	 * rate that is actually seeing signal even before full lock.
	 */
	getStatus(): POCSAGStatus {
		const subs = [this._d2400.getStatus(), this._d1200.getStatus(), this._d512.getStatus()];
		const locked = subs.find((s) => s.synced);
		if (locked) return locked;
		// Not locked: report whichever rate has the strongest recent evidence.
		return subs.reduce((best, s) => (s.codewords > best.codewords ? s : best), subs[0]);
	}
}
