/* eslint-disable max-lines */
import type { GSCMessage, GSCRxState, GSCVoiceEndReason, GSCStatus } from './gsc.types';
import { GSC_CHAR_OK, GSC_CHAR_CORRECTED, GSC_CHAR_UNCORRECTABLE } from './gsc.types';
import { FskBitSlicer, BerWindow } from './fsk-frontend';
import { initFec, decodeGolay, decodeBch, calcBch, readDupGolay, deinterleaveBch } from './golay-fec';
import { ALPHA_FILL, NUMERIC_FILL, buildAlpha, buildNumeric, scoreAlpha, scoreNumeric } from './golay-text';

/*
 * GSC (Golay Sequential Code) paging decoder for BrowSDR.
 *
 * Translated from osmocom-analog src/golay/golay.c (RX path) against ITU-R
 * Report 900-2. Operates on FM-demodulated Float32 audio at 600 baud, using the
 * shared FskBitSlicer for DC removal / timing / bit recovery (the same front end
 * POCSAG uses). Everything here is GSC-specific: Golay(23,12) + BCH(15,7) FEC,
 * the preamble -> start-code -> address -> data-block framing, the Table VI
 * address codec, and the single Table VII character set (default-only; GSC has
 * no national/vendor codepages).
 *
 * Bit order on the wire is LSB-first; the encoder transmits each Golay codeword
 * bit twice (queue_dup). The generator polynomials are the LSB-first reciprocals
 * of the nominal spec polynomials and are conformant under that convention.
 */

const BAUD = 600;

// Rep. 900-2 framing constants (match the encoder's hardcoded values).
const START_CODE = 713;
const ACTIVATION_CODE = 2563;
const COMMA_LEN = 28; // comma sequence length (bits)
const DUP_BITS = 46; // duplicate-transmitted Golay codeword (23 x 2)
const BCH_BLOCK_BITS = 120; // interleaved BCH block (15 x 8)
const TONE_COMMA_LEN = 121 * 8; // tone-only comma (968 bits)

// Rep. 900-2 Table VI.
const WORD1S: number[] = [
	721, 2731, 2952, 1387, 1578, 1708, 2650, 1747, 2580, 1376, 2692, 696, 1667, 3800, 3552, 3424, 1384, 3595, 876, 3124, 2285, 2608, 899,
	3684, 3129, 2124, 1287, 2616, 1647, 3216, 375, 1232, 2824, 1840, 408, 3127, 3387, 882, 3468, 3267, 1575, 3463, 3152, 2572, 1252, 2592,
	1552, 835, 1440, 160,
];

// 10 preamble codewords (Rep. 900-2); preamble = (I + G0) % 10 selects one.
const PREAMBLE_VALUES: number[] = [2030, 1628, 3198, 647, 191, 3315, 1949, 2540, 1560, 2335];

// Invalid GSC address codes (Appendix I), keyed by group range.
const ILLEGAL_LOW = [0, 25, 51, 103, 206, 340, 363, 412, 445, 530, 642, 726, 782, 810, 825, 877];
const ILLEGAL_HIGH = [0, 292, 425, 584, 631, 841, 851];
// ── Address codec (reverse of encode_address) ──────────────────────────────

function reverseWord1(w1: number): { g1: number; g0: number } | null {
	for (let i = 0; i < 50; i++) {
		if (WORD1S[i] === w1) return { g1: Math.floor(i / 10), g0: i % 10 };
	}
	return null;
}

function reverseWord2(w2: number, g1g0: number): { a2: number; a1: number; a0: number } | null {
	const raw = g1g0 >= 50 ? w2 - 50 : w2;
	if (raw < 0) return null;
	const b3b2 = Math.floor(raw / 100);
	const b1b0 = raw % 100;
	const ap3 = Math.floor(b3b2 / 10);
	const ap2 = b3b2 % 10;
	const ap1 = Math.floor((b1b0 * 2) / 10);
	const ap0 = (b1b0 * 2) % 10;
	const ap = ap3 * 1000 + ap2 * 100 + ap1 * 10 + ap0;
	const a2 = Math.floor(ap / 200);
	const a1 = Math.floor(ap / 20) % 10;
	const a0 = Math.floor(ap / 2) % 10;
	if (a2 < 0 || a2 > 9 || a1 < 0 || a1 > 9 || a0 < 0 || a0 > 9) return null;
	const a2a1a0 = a2 * 100 + a1 * 10 + a0;
	const illegal = g1g0 < 50 ? ILLEGAL_LOW : ILLEGAL_HIGH;
	if (illegal.includes(a2a1a0)) return null;
	return { a2, a1, a0 };
}

// ── Streaming decoder ──────────────────────────────────────────────────────

export class GSCDecoder {
	private readonly onMessage: (msg: GSCMessage) => void;
	private readonly slicer: FskBitSlicer;
	private readonly ber = new BerWindow();

	// 46-bit sliding window of the most recent bits (shift[0]=oldest). A GSC
	// codeword is dup-transmitted (each of 23 bits sent twice), so a codeword
	// occupies 46 wire bits; resolve the window as a dup Golay codeword.
	private shift: number[] = [];
	private state: GSCRxState = 'idle';
	private preambleIndex = -1;
	private inverted = false; // preamble detected at inverted polarity
	// PREAMBLE confirmation: collect 46-bit groups and require consecutive
	// matches of the same preamble index.
	private confirmIndex = -1;
	private confirmCount = 0;
	private confirmBits: number[] = [];
	// DATA collection + end-of-transmission (48+ consecutive same-value bits).
	private bits: number[] = [];
	private lastBit = -1;
	private noTransition = 0;
	private synced = false;
	// When true, emit the runner-up alpha/numeric reading as msg.alt. Off by
	// default (POCSAG-style second guess, opt-in via setShowSecondGuess).
	private showSecondGuess = false;
	// In-DATA new-preamble rescan (for continuous/back-to-back batches).
	private dataPreIdx = -1;
	private dataPreInv = false;
	private dataPreCount = 0;
	// Set while a voice page is in progress (between its start batch and EOT),
	// so a matching 'stop' event can be emitted when the transmission ends.
	private voiceActive = false;
	private voiceAddress = '';
	// RX_VOICE counters, in SAMPLES (osmocom decrements these per audio buffer
	// in sender_receive, independent of bit activity). voiceAlertWait suppresses
	// stop detection while the pager alerts (TX silent); voiceTimeout is the
	// 2-minute recording cap.
	private voiceAlertWait = 0;
	private voiceTimeout = 0;
	// osmocom rx_bit_num>=1 guard: silence counting starts only after the first
	// post-alert bit (so the very first bit is never a false "no transition").
	private voiceSeenBit = false;

	private static PREAMBLE_LOCK_THRESHOLD = 3;
	// End-of-transmission: consecutive same-value bits that mean the TX stopped.
	private static EOT_BITS = 48;
	// Minimum bits for a valid batch: start code (121) + address (121).
	private static MIN_BATCH_BITS = 242;
	// Safety cap: buffered more than the longest practical single transmission
	// without a decode -> signal is garbage, give up (osmocom uses 4096).
	private static MAX_COLLECT_BITS = 4096;
	// Voice-stop scan: only accept a VALID codeword - one that decodes with few
	// corrections. A real stop codeword is sent clean (0 errors); noise needs
	// Voice-stop scan: only accept a VALID codeword - one that decodes with few
	// corrections. A real stop codeword is sent clean; noise tends to need the
	// full 3-bit Golay correction to hit a valid value, so require <=2 (osmocom
	// accepts the full <=3 and false-triggers on real-radio noise).
	private static VOICE_STOP_ERR_MAX = 2;

	private readonly audioRate: number;

	constructor(audioRate: number, onMessage: (msg: GSCMessage) => void) {
		initFec();
		this.audioRate = audioRate;
		this.onMessage = onMessage;
		this.slicer = new FskBitSlicer(audioRate, BAUD, (bit) => this._onBit(bit));
	}

	reset(): void {
		this.slicer.reset();
		this.ber.reset();
		this.shift = [];
		this.state = 'idle';
		this.preambleIndex = -1;
		this.inverted = false;
		this.confirmIndex = -1;
		this.confirmCount = 0;
		this.confirmBits = [];
		this.bits = [];
		this.lastBit = -1;
		this.noTransition = 0;
		this.synced = false;
		this.voiceActive = false;
		this.voiceAddress = '';
	}

	process(samples: Float32Array): void {
		// RX_VOICE sample-based timing (osmocom sender_receive): drain the alert
		// pause and the recording timeout by sample count, independent of bit
		// activity. The timeout fires a stop; the bit handler checks alert-wait.
		if (this.state === 'voice') {
			if (this.voiceAlertWait > 0) {
				this.voiceAlertWait -= Math.min(this.voiceAlertWait, samples.length);
			}
			this.voiceTimeout -= samples.length;
			if (this.voiceTimeout <= 0) {
				this._emitVoiceStop('timeout');
				return;
			}
		}
		this.slicer.process(samples);
	}

	getStatus(): GSCStatus {
		const stage = this.synced ? (this.state === 'voice' || this.voiceActive ? 'voice' : 'data') : null;
		return {
			synced: this.synced,
			baud: this.synced ? BAUD : null,
			inverted: this.inverted,
			ber: this.ber.ber,
			codewords: this.ber.count,
			stage,
		};
	}

	/** Enable/disable emitting the runner-up alpha/numeric reading as msg.alt. */
	setShowSecondGuess(on: boolean): void {
		this.showSecondGuess = on;
	}

	/** Resolve a 46-bit dup window into a 23-bit Golay codeword (LSB-first,
	 * each bit sent twice; prefer the first of a disagreeing pair). */
	private static resolveWindow(w: number[]): number {
		let cw = 0;
		for (let i = 0; i < 23; i++) cw |= (w[i * 2] & 1) << i;
		return cw >>> 0;
	}

	/** Try to decode the current 46-bit window as a preamble codeword (both
	 * polarities). Returns {idx, inverted} or null. */
	private matchPreamble(): { idx: number; inverted: boolean } | null {
		const cw = GSCDecoder.resolveWindow(this.shift);
		let d = decodeGolay(cw);
		if (d) {
			const idx = PREAMBLE_VALUES.indexOf(d.data);
			if (idx >= 0) return { idx, inverted: false };
		}
		d = decodeGolay((cw ^ 0x7fffff) >>> 0);
		if (d) {
			const idx = PREAMBLE_VALUES.indexOf(d.data);
			if (idx >= 0) return { idx, inverted: true };
		}
		return null;
	}

	/** RX_DATA bit handling: buffer (de-inverted), watch for the next batch's
	 * preamble (continuous TX), and flush on EOT. */
	private _onCollectBit(b: number): void {
		const stored = this.inverted ? b ^ 1 : b;
		this.bits.push(stored);
		if (stored === this.lastBit) this.noTransition++;
		else this.noTransition = 0;
		this.lastBit = stored;

		this.shift.push(b);
		if (this.shift.length > 46) this.shift.shift();
		if (this.shift.length === 46 && this._rescanDataPreamble()) return;

		const n = this.bits.length;
		if (n < GSCDecoder.MIN_BATCH_BITS) return;

		// End-of-transmission (clean): a long run of constant bits. Trim the
		// trailing run, force-decode, and return to idle (or voice) by result.
		if (this.noTransition >= GSCDecoder.EOT_BITS) {
			let nbits = n - this.noTransition;
			if (nbits < GSCDecoder.MIN_BATCH_BITS) nbits = GSCDecoder.MIN_BATCH_BITS;
			const r = this._decodeBuffer(this.bits.slice(0, nbits), true);
			if (r === 'voice') this._enterVoice();
			else this._resetIdle();
			return;
		}
		// Safety cap: buffered more than any valid batch without a decode.
		if (n >= GSCDecoder.MAX_COLLECT_BITS) {
			const r = this._decodeBuffer(this.bits, true);
			if (r === 'voice') this._enterVoice();
			else this._resetIdle();
			return;
		}
		// Periodic decode (real-radio path): after TX stops the demodulator
		// emits noisy transitions so the no-transition EOT never fires. Attempt
		// a non-forced decode every 46 bits (one codeword period); on success
		// enter voice (voice page) or return to idle (data) to re-sync fresh.
		if (n % 46 === 0) {
			const r = this._decodeBuffer(this.bits, false);
			if (r === 'voice') this._enterVoice();
			else if (r === 'decoded') this._resetIdle();
		}
	}

	/** Sliding preamble rescan during RX_DATA. On a confirmed new preamble,
	 * force-decode the batch collected before it and re-lock. Returns true when
	 * it re-locked (caller should stop processing this bit). */
	private _rescanDataPreamble(): boolean {
		const m = this.matchPreamble();
		if (m && m.idx === this.dataPreIdx && m.inverted === this.dataPreInv) this.dataPreCount++;
		else if (m) {
			this.dataPreIdx = m.idx;
			this.dataPreInv = m.inverted;
			this.dataPreCount = 1;
		} else this.dataPreCount = 0;

		if (this.dataPreCount < GSCDecoder.PREAMBLE_LOCK_THRESHOLD) return false;

		const oldBits = this.bits.length - this.dataPreCount * 46;
		if (oldBits >= 242 && this._decodeBuffer(this.bits.slice(0, oldBits)) === 'voice') {
			this._enterVoice();
			return true;
		}
		this.preambleIndex = this.dataPreIdx;
		this.inverted = this.dataPreInv;
		this.bits = [];
		this.lastBit = -1;
		this.noTransition = 0;
		this.dataPreCount = 0;
		return true;
	}

	private _onBit(bit: number): void {
		const b = bit & 1;

		if (this.state === 'collect') {
			this._onCollectBit(b);
			return;
		}

		if (this.state === 'voice') {
			this._onVoiceBit(b);
			return;
		}

		// IDLE: 46-bit sliding window, resolved as a dup Golay codeword each bit;
		// on a preamble match, enter PREAMBLE confirmation.
		if (this.state === 'idle') {
			this.shift.push(b);
			if (this.shift.length > 46) this.shift.shift();
			if (this.shift.length < 46) return;
			const m = this.matchPreamble();
			if (m) {
				this.confirmIndex = m.idx;
				this.inverted = m.inverted;
				this.confirmCount = 1;
				this.confirmBits = [];
				this.state = 'preamble';
			}
			return;
		}

		// PREAMBLE: accumulate 46-bit groups, require consecutive matches of the
		// same preamble index; lock after PREAMBLE_LOCK_THRESHOLD.
		if (this.state === 'preamble') {
			this.confirmBits.push(b);
			if (this.confirmBits.length < 46) return;
			let cw = GSCDecoder.resolveWindow(this.confirmBits);
			this.confirmBits = [];
			if (this.inverted) cw = (cw ^ 0x7fffff) >>> 0;
			const d = decodeGolay(cw);
			const idx = d ? PREAMBLE_VALUES.indexOf(d.data) : -1;
			if (idx !== this.confirmIndex) {
				this._resetIdle();
				return;
			}
			this.confirmCount++;
			if (this.confirmCount >= GSCDecoder.PREAMBLE_LOCK_THRESHOLD) {
				this.preambleIndex = this.confirmIndex;
				this.synced = true;
				this.bits = [];
				this.lastBit = -1;
				this.noTransition = 0;
				this.state = 'collect';
				// Freeze DC estimate now that we are locked — mirrors the POCSAG
				// syncPhase() call at FSC. The alternating preamble gave unbiased
				// DC updates; from here same-symbol IDLE runs must not drift it.
				this.slicer.syncPhase();
			}
			return;
		}
	}

	private _resetIdle(): void {
		this.voiceActive = false;
		this.voiceAddress = '';
		this.voiceAlertWait = 0;
		this.voiceTimeout = 0;
		this.voiceSeenBit = false;
		this.state = 'idle';
		this.synced = false;
		this.shift = [];
		this.confirmBits = [];
		this.confirmCount = 0;
		this.confirmIndex = -1;
		this.dataPreCount = 0;
		this.dataPreIdx = -1;
		// Unfreeze DC tracker so it can re-acquire during the next preamble.
		this.slicer.pllLocked = false;
		// Reset BER window so hunt state reports null (no stale data from last lock).
		this.ber.reset();
	}
	/** Decode a buffer and emit the message. Returns 'voice' if a voice page
	 * started (caller must enter voice state, NOT reset), 'decoded' for any
	 * other emitted message (caller resets to idle), or 'none'. */
	private _decodeBuffer(buf: number[], force = true): 'voice' | 'decoded' | 'none' {
		const msg = decodeBatch(buf, this.preambleIndex, force, this.ber);
		if (!msg) return 'none';
		msg.inverted = this.inverted;
		if (!this.showSecondGuess) msg.alt = undefined; // runner-up only when opted in
		if (msg.voiceEvent === 'start') {
			this.voiceActive = true;
			this.voiceAddress = msg.address;
			this.onMessage(msg);
			return 'voice';
		}
		this.onMessage(msg);
		return 'decoded';
	}

	/** Enter RX_VOICE after a voice page start: defer the 'stop' until the
	 * transmission actually ends (silence, new preamble, or timeout). Faithful
	 * port of osmocom rx_enter_voice. */
	private _enterVoice(): void {
		this.state = 'voice';
		// osmocom rx_enter_voice: rx_shift_count=0, rx_no_transition=0,
		// rx_bit_num=0, voice_alert_wait=samplerate*2, voice_timeout=samplerate*120.
		this.shift = [];
		this.noTransition = 0;
		this.lastBit = -1;
		this.voiceSeenBit = false;
		this.voiceAlertWait = this.audioRate * 2;
		this.voiceTimeout = this.audioRate * 120;
	}

	/** Emit the voice 'stop' event (if a voice page is active) and reset. */
	private _emitVoiceStop(reason: GSCVoiceEndReason): void {
		if (this.voiceActive) {
			this.onMessage({
				protocol: 'gsc',
				address: this.voiceAddress,
				addressNumber: 0,
				type: 'voice',
				text: '',
				charStatus: [],
				errorCount: 0,
				uncorrectableCount: 0,
				preambleIndex: -1,
				voiceEvent: 'stop',
				voiceEndReason: reason,
				inverted: this.inverted,
			});
		}
		this._resetIdle();
	}

	/** RX_VOICE bit handling — line-for-line port of osmocom dsp.c RX_VOICE.
	 * Alert-wait (drained by samples in process()) suppresses stop detection;
	 * then stop on silence (48 consecutive same-value bits) or a sliding-window
	 * match of a new preamble / the activation code. Timeout is in process(). */
	private _onVoiceBit(b: number): void {
		// No stop detection during the alert pause (TX silent while pager alerts).
		if (this.voiceAlertWait > 0) return;

		// Silence detection: count consecutive same-value bits (guarded so the
		// first post-alert bit does not false-count). osmocom rx_no_transition.
		if (this.voiceSeenBit && b === this.lastBit) this.noTransition++;
		else this.noTransition = 0;
		this.lastBit = b;
		this.voiceSeenBit = true;
		if (this.noTransition >= GSCDecoder.EOT_BITS) {
			this._emitVoiceStop('silence');
			return;
		}

		// Voice-stop scan — single 46-bit sliding window, two distinct cases:
		//
		//  - ACTIVATION (stop word): part of THIS transmission, so it is sent at
		//    the SAME polarity as the start. Decode at the locked polarity only.
		//  - NEXT PREAMBLE: a new, separate transmission that may have ANY
		//    polarity of its own, so check both.
		//
		// Both must be a VALID codeword (<=VOICE_STOP_ERR_MAX corrections): a real
		// codeword decodes near-clean, noise tends to need all 3. Silence: above.
		// All of these (plus the sample-based timeout in process()) run every bit
		// in parallel; whichever condition fires first ends the voice page.
		this.shift.push(b);
		if (this.shift.length > 46) this.shift.shift();
		if (this.shift.length < 46) return;
		const raw = GSCDecoder.resolveWindow(this.shift);

		// Activation stop word — same polarity as the transmission start.
		const same = decodeGolay(this.inverted ? (raw ^ 0x7fffff) >>> 0 : raw);
		if (same && same.errors <= GSCDecoder.VOICE_STOP_ERR_MAX && same.data === ACTIVATION_CODE) {
			this._emitVoiceStop('activation');
			return;
		}
		// Next-transmission preamble — any polarity.
		const dn = decodeGolay(raw);
		const di = decodeGolay((raw ^ 0x7fffff) >>> 0);
		const pre = dn && di ? (dn.errors <= di.errors ? dn : di) : (dn ?? di);
		if (pre && pre.errors <= GSCDecoder.VOICE_STOP_ERR_MAX && PREAMBLE_VALUES.includes(pre.data)) {
			this._emitVoiceStop('preamble');
		}
	}
}

/**
 * Decode one GSC batch from a collected bit buffer. Returns a message or null.
 * Faithful port of golay.c decode_batch: start code -> address (W1/W2 with
 * inversion + range detection) -> type detection -> data blocks. Both alpha and
 * numeric interpretations are produced and the winner is chosen by trailing-fill
 * count then content (gsc_discriminate).
 */
export function decodeBatch(bits: number[], preambleIdx: number, force: boolean, ber?: BerWindow): GSCMessage | null {
	const total = bits.length;
	if (total < COMMA_LEN + DUP_BITS) return null;

	const sc = scanStartCode(bits, ber);
	if (!sc) return null;
	let pos = sc.pos;
	let errorCount = sc.errors;

	// Stage 3: address.
	if (pos + COMMA_LEN + DUP_BITS + 1 + DUP_BITS > total) return null;
	pos += COMMA_LEN;
	const addr = decodeAddress(bits, pos);
	if (!addr) return null;
	pos = addr.pos;
	const { g1, g0, a2, a1, a0, func } = addr;
	const idx = (preambleIdx - g0 + 10) % 10;

	// Type detection + data decode.
	const content = decodeContent(bits, pos, force, ber);
	if (content === 'need-more') return null;
	errorCount += content.errors;

	const suffix = functionSuffix(content.type, func);
	const address = `${idx}${g1}${g0}${a2}${a1}${a0}${suffix}`;

	return {
		protocol: 'gsc',
		address,
		addressNumber: func + 1,
		type: content.type,
		text: content.text,
		charStatus: content.charStatus,
		errorCount,
		uncorrectableCount: content.uncorrectable,
		preambleIndex: preambleIdx,
		...(content.alt ? { alt: content.alt } : {}),
		...(content.type === 'voice' ? { voiceEvent: 'start' as const } : {}),
	};
}

/** Stage 2: scan for the start code and verify its complement. Returns the
 * position just past the complement codeword, or null. */
function scanStartCode(bits: number[], ber?: BerWindow): { pos: number; errors: number } | null {
	const total = bits.length;
	let errors = 0;
	let pos = -1;
	const scanEnd = Math.min(total - COMMA_LEN - DUP_BITS, 800);
	for (let scanPos = 0; scanPos <= scanEnd; scanPos++) {
		const tryPos = scanPos + COMMA_LEN;
		if (tryPos + DUP_BITS > total) break;
		const { cw } = readDupGolay(bits, tryPos);
		// Start code may arrive at either polarity; the TX polarity is a property
		// of the whole transmission and is not known here independently.
		const dn = decodeGolay(cw);
		const di = decodeGolay((cw ^ 0x7fffff) >>> 0);
		const d = dn && dn.data === START_CODE ? dn : di && di.data === START_CODE ? di : null;
		if (d) {
			pos = tryPos + DUP_BITS;
			errors += d.errors;
			if (ber) ber.add(d.errors, 23);
			break;
		}
	}
	if (pos < 0) return null;
	pos += 1; // skip 1-bit inverted comma
	const r = readDupGolay(bits, pos);
	pos = r.pos;
	// Complement codeword verifies against the start code at either polarity.
	const cn = decodeGolay((r.cw ^ 0x7fffff) >>> 0);
	const cc = decodeGolay(r.cw);
	if (!((cn && cn.data === START_CODE) || (cc && cc.data === START_CODE))) errors++;
	return { pos, errors };
}

/** Stage 3: decode the W1/W2 address pair with inversion + range detection. */
function decodeAddress(
	bits: number[],
	startPos: number,
): { pos: number; g1: number; g0: number; a2: number; a1: number; a0: number; func: number } | null {
	let pos = startPos;

	// W1 with inversion detection.
	const r1 = readDupGolay(bits, pos);
	pos = r1.pos;
	const w1 = resolveWord1(r1.cw);
	if (!w1) return null;
	const rw1 = reverseWord1(w1.value);
	if (!rw1) return null;
	let g1g0 = rw1.g1 * 10 + rw1.g0;

	pos += 1; // skip 1-bit inverted comma

	// W2 with inversion + range detection.
	const r2 = readDupGolay(bits, pos);
	pos = r2.pos;
	const tries: Array<{ val: number; inv: boolean }> = [];
	const dn = decodeGolay(r2.cw);
	if (dn) tries.push({ val: dn.data, inv: false });
	const di = decodeGolay((r2.cw ^ 0x7fffff) >>> 0);
	if (di) tries.push({ val: di.data, inv: true });
	let best: { a2: number; a1: number; a0: number; inv: boolean; range: number } | null = null;
	for (const t of tries) {
		const range = t.val % 100 >= 50 ? 1 : 0;
		const ra = reverseWord2(t.val, g1g0 + range * 50);
		if (ra && !best) best = { ...ra, inv: t.inv, range };
	}
	if (!best) return null;
	if (best.range) g1g0 += 50;
	const func = (w1.inverted ? 0x2 : 0) | (best.inv ? 0x1 : 0);
	return { pos, g1: Math.floor(g1g0 / 10), g0: g1g0 % 10, a2: best.a2, a1: best.a1, a0: best.a0, func };
}

/** Resolve a W1 dup-Golay codeword to its value + inversion, or null. */
function resolveWord1(cw: number): { value: number; inverted: boolean } | null {
	const d = decodeGolay(cw);
	if (d && WORD1S.includes(d.data)) return { value: d.data, inverted: false };
	const di = decodeGolay((cw ^ 0x7fffff) >>> 0);
	if (di && WORD1S.includes(di.data)) return { value: di.data, inverted: true };
	return null;
}

/** Type detection + content decode after the address. Returns 'need-more' when
 * not enough bits are buffered yet (and not forced). */
function decodeContent(
	bits: number[],
	pos: number,
	force: boolean,
	ber?: BerWindow,
):
	| 'need-more'
	| {
			type: GSCMessage['type'];
			text: string;
			charStatus: number[];
			errors: number;
			uncorrectable: number;
			alt?: { type: 'alpha' | 'numeric'; text: string };
	  } {
	const remaining = bits.length - pos;

	// Voice: activation code after a 28-bit comma.
	if (remaining >= COMMA_LEN + DUP_BITS + 1 + DUP_BITS) {
		const peek = readDupGolay(bits, pos + COMMA_LEN);
		const pd = decodeGolay(peek.cw);
		if (pd && pd.data === ACTIVATION_CODE) return { type: 'voice', text: '', charStatus: [], errors: 0, uncorrectable: 0 };
	}

	if (remaining >= 1 + BCH_BLOCK_BITS) {
		const data = decodeDataBlocks(bits, pos, force, ber);
		if (data === 'need-more') return 'need-more';
		if (data) return data;
		if (remaining < TONE_COMMA_LEN && !force) return 'need-more';
	} else if (!force) {
		return 'need-more';
	}
	return { type: 'tone', text: '', charStatus: [], errors: 0, uncorrectable: 0 };
}

/** Function suffix per Function Plan A. */
function functionSuffix(type: GSCMessage['type'], func: number): string {
	if (type === 'voice') return String.fromCharCode('1'.charCodeAt(0) + func);
	if (type === 'alpha' || type === 'numeric') return String.fromCharCode('5'.charCodeAt(0) + func);
	return '9034'[func];
}

/** Decode one de-interleaved BCH block: 8 codewords -> 8 data bytes, plus the
 * per-block FEC status and correction count. */
function decodeBchBlock(
	cws: number[],
	ber?: BerWindow,
): { d: number[]; ok: boolean; corrected: boolean; errors: number; uncorrectable: number } {
	const d: number[] = [];
	let ok = true;
	let corrected = false;
	let errors = 0;
	let uncorrectable = 0;
	for (let k = 0; k < 8; k++) {
		const r = decodeBch(cws[k]);
		if (!r) {
			ok = false;
			uncorrectable++;
			d.push(0);
		} else {
			errors += r.errors;
			if (r.errors > 0) corrected = true;
			if (ber) ber.add(r.errors, 15);
			d.push(r.data);
		}
	}
	return { d, ok, corrected, errors, uncorrectable };
}

/** Collect consecutive BCH data blocks: de-interleave, decode all 8 codewords,
 * verify checksum, follow the continuation bit. Returns the concatenated 7
 * payload bytes per block plus error stats, 'need-more' if the continuation
 * bit is set but the next block is not fully buffered yet (and not forced), or
 * null if the first block is not a valid data block (checksum fails -> tone). */
function collectDataBlocks(
	bits: number[],
	startPos: number,
	force: boolean,
	ber?: BerWindow,
):
	| { dAll: number[]; blockStatus: number[]; blocks: number; errors: number; uncorrectable: number; checksumOk: number }
	| 'need-more'
	| null {
	let pos = startPos;
	const dAll: number[] = [];
	const blockStatus: number[] = [];
	let errors = 0;
	let uncorrectable = 0;
	let checksumOk = 0;
	let blocks = 0;
	let contbit = 1;
	const total = bits.length;

	while (contbit && blocks < 32) {
		// Continuation set but the next block is not fully buffered: wait for
		// more bits unless forced (prevents emitting a truncated multi-block).
		if (pos + 1 + BCH_BLOCK_BITS > total) {
			if (!force && blocks > 0) return 'need-more';
			break;
		}
		pos += 1; // skip 1-bit inverted comma
		const de = deinterleaveBch(bits, pos);
		pos = de.pos;
		const blk = decodeBchBlock(de.bch, ber);
		const { d, ok } = blk;
		errors += blk.errors;
		uncorrectable += blk.uncorrectable;
		if (blocks === 0 && !ok) return null; // first block must decode
		// Checksum: d[7] == (sum of the full BCH codewords of d[0..6]) & 0x7f.
		let cksum = 0;
		for (let k = 0; k < 7; k++) cksum += calcBch(d[k]);
		cksum &= 0x7f;
		// First-block checksum gate: a valid data block MUST checksum, else this
		// is a tone-only comma (or noise) mis-read as data -> reject.
		if (blocks === 0 && cksum !== d[7]) return null;
		if (cksum === d[7]) checksumOk++;
		else errors++;
		// Continuation bit is bit 6 of d[6] (encoder: (contbit<<6)|msg[7]).
		contbit = ok ? (d[6] >> 6) & 1 : 0;
		for (let k = 0; k < 7; k++) dAll.push(d[k]);
		// Per-block confidence: uncorrectable beats corrected beats ok.
		blockStatus.push(!ok ? GSC_CHAR_UNCORRECTABLE : blk.corrected ? GSC_CHAR_CORRECTED : GSC_CHAR_OK);
		blocks++;
	}
	if (blocks === 0) return null;
	return { dAll, blockStatus, blocks, errors, uncorrectable, checksumOk };
}

/** Decode consecutive BCH data blocks until the continuation bit clears, both
 * as alpha (6-bit) and numeric (4-bit), then pick the winner by trailing fill
 * then content score. pos points at the 1-bit inverted comma before block 1. */
function decodeDataBlocks(
	bits: number[],
	startPos: number,
	force: boolean,
	ber?: BerWindow,
):
	| {
			type: 'alpha' | 'numeric';
			text: string;
			charStatus: number[];
			errors: number;
			uncorrectable: number;
			alt: { type: 'alpha' | 'numeric'; text: string };
	  }
	| 'need-more'
	| null {
	const collected = collectDataBlocks(bits, startPos, force, ber);
	if (collected === 'need-more') return 'need-more';
	if (!collected) return null;
	const { dAll, blockStatus, blocks, errors, uncorrectable } = collected;

	// Unpack alpha (6-bit) and numeric (4-bit) from each 7-byte block group,
	// tracking which source block each code came from so per-block FEC status
	// can be mapped onto the characters that block produced.
	const alphaCodes: number[] = [];
	const alphaBlk: number[] = [];
	const numNibbles: number[] = [];
	const numBlk: number[] = [];
	for (let b = 0; b < blocks; b++) {
		const p = b * 7;
		const x = (i: number) => dAll[p + i] & 0x7f;
		const a = [
			x(0) & 0x3f,
			((x(0) >> 6) | (x(1) << 1)) & 0x3f,
			((x(1) >> 5) | (x(2) << 2)) & 0x3f,
			((x(2) >> 4) | (x(3) << 3)) & 0x3f,
			((x(3) >> 3) | (x(4) << 4)) & 0x3f,
			((x(4) >> 2) | (x(5) << 5)) & 0x3f,
			(x(5) >> 1) & 0x3f,
			x(6) & 0x3f,
		];
		for (const code of a) {
			alphaCodes.push(code);
			alphaBlk.push(b);
		}
		const n = [
			x(0) & 0xf,
			((x(0) >> 4) | (x(1) << 3)) & 0xf,
			(x(1) >> 1) & 0xf,
			((x(1) >> 5) | (x(2) << 2)) & 0xf,
			(x(2) >> 2) & 0xf,
			((x(2) >> 6) | (x(3) << 1)) & 0xf,
			(x(3) >> 3) & 0xf,
			x(4) & 0xf,
			((x(4) >> 4) | (x(5) << 3)) & 0xf,
			(x(5) >> 1) & 0xf,
			((x(5) >> 5) | (x(6) << 2)) & 0xf,
			(x(6) >> 2) & 0xf,
		];
		for (const nib of n) {
			numNibbles.push(nib);
			numBlk.push(b);
		}
	}

	// Trailing fill counts (structural: encoder pads unused slots).
	let alphaFill = 0;
	for (let i = alphaCodes.length - 1; i >= 0 && alphaCodes[i] === ALPHA_FILL; i--) alphaFill++;
	let numFill = 0;
	for (let i = numNibbles.length - 1; i >= 0 && numNibbles[i] === NUMERIC_FILL; i--) numFill++;

	// Decode both interpretations, carrying per-output-char block indices.
	const alpha = buildAlpha(alphaCodes, alphaBlk);
	const num = buildNumeric(numNibbles, numBlk);

	// Discriminate by content score (osmocom gsc_discriminate): each score folds
	// per-symbol plausibility and a quadratic trailing-fill bonus. Higher wins;
	// tie -> alpha.
	const alphaScore = scoreAlpha(alphaCodes, alphaFill);
	const numScore = scoreNumeric(numNibbles, numFill);
	const type: 'alpha' | 'numeric' = numScore > alphaScore ? 'numeric' : 'alpha';
	const chosen = type === 'alpha' ? alpha : num;
	const runnerUp = type === 'alpha' ? num : alpha;

	// Per-character status = the FEC status of the block that produced it.
	const charStatus = chosen.blk.map((b) => blockStatus[b] ?? GSC_CHAR_OK);
	const alt: { type: 'alpha' | 'numeric'; text: string } = { type: type === 'alpha' ? 'numeric' : 'alpha', text: runnerUp.text };
	return { type, text: chosen.text, charStatus, errors, uncorrectable, alt };
}
// re-exported so a test harness can drive the FEC directly.
export { calcBch, readDupGolay, deinterleaveBch, initFec, decodeGolay, decodeBch } from './golay-fec';
export { reverseWord1, reverseWord2 };
