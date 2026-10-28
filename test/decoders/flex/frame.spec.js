import { describe, it, expect } from 'vitest';
import { bchEncode, bchDecode } from '@/worker/decoders/flex/bch';
import { decodeFiw } from '@/worker/decoders/flex/fiw';
import { decodePhase, decodeFrame, FlexFrameDecoder } from '@/worker/decoders/flex/frame';
import { describeInstruction } from '@/worker/decoders/flex/group';
import { verifyNumericKChecksum } from '@/worker/decoders/flex/numeric';
import { formatFlexTime } from '@/worker/decoders/flex/flextime';

// -- Synthetic FLEX frame builder --------------------------------------------
// Build a phase buffer directly at the 21-bit info-word level and BCH-encode
// each word into the RX codeword layout, so decodePhase exercises the real
// address/vector/message extraction without needing the audio path. This
// proves the frame-content decode (BIW -> address -> vector -> message),
// complementing frontend.spec.js which proves the symbol/sync path.

const WPF = 88;

function makePhase() {
	return {
		words: new Uint32Array(WPF),
		status: new Int8Array(WPF),
		lowConfBitA: new Uint32Array(WPF),
		lowConfBitB: new Uint32Array(WPF),
		altWords: new Uint32Array(WPF),
		idleCount: 0,
	};
}

/** Place a 21-bit info word at index i as a CLEAN BCH codeword. */
function put(ph, i, info) {
	ph.words[i] = bchEncode(info);
	ph.status[i] = 1; // CLEAN (matches frame.ts WORD_CLEAN)
}

/** BIW word 0: aoffset = address-field start, voffset = vector-field start. */
function biw(aoffset, voffset) {
	return (((aoffset - 1) & 0x03) << 8) | ((voffset & 0x3f) << 10);
}

/** Vector word: type(4-6), start mw1(7-13), length(14-20). */
function vector(type, mw1, len) {
	return ((type & 0x07) << 4) | ((mw1 & 0x7f) << 7) | ((len & 0x7f) << 14);
}

/** Alpha word: three 7-bit chars at bit offsets 0, 7, 14. */
function alphaWord(a, b, c) {
	return ((a & 0x7f) | ((b & 0x7f) << 7) | ((c & 0x7f) << 14)) & 0x1fffff;
}

/** Pack a short string (<=3 chars, pad with ETX) into one alpha word. */
function alpha(str) {
	const cc = (k) => (k < str.length ? str.charCodeAt(k) : 0x03);
	return alphaWord(cc(0), cc(1), cc(2));
}

/**
 * Alpha fragment header word. flag: 'K' complete (F=11,C=0), 'F' continued
 * (C=1), 'C' final (C=0, F!=11). msgNum in bits 13-18.
 */
function alphaHdr(flag, msgNum = 0, fragNum = 3) {
	const c = flag === 'F' ? 1 : 0;
	const f = flag === 'K' ? 3 : fragNum;
	return (((c & 1) << 10) | ((f & 3) << 11) | ((msgNum & 0x3f) << 13)) & 0x1fffff;
}

/**
 * First data word of an initial alpha fragment: slot-0 (bits 0-6) is the
 * 7-bit signature (not a character), slots 1-2 are the first two chars.
 */
function sigWord(sig, c1, c2) {
	return alphaWord(sig & 0x7f, c1 ? c1.charCodeAt(0) : 0x03, c2 ? c2.charCodeAt(0) : 0x03);
}

const FIW = { cycle: 3, frame: 42, roaming: 0, repeat: 0, traffic: 0, numTransmissions: 1, tdCollapse: -1 };

describe('FLEX frame decode', () => {
	it('decodes a short-address alphanumeric message', () => {
		const ph = makePhase();
		const capcode = 1234567;
		put(ph, 0, biw(1, 2)); // addr at 1, vectors at 2
		put(ph, 1, capcode + 32768); // short address word
		put(ph, 2, vector(0x5, 3, 3)); // ALPHA, body at words 3..5 (hdr + 2 text)
		put(ph, 3, alphaHdr('K')); // fragment header: complete (F=11, C=0)
		put(ph, 4, sigWord(0x42, 'H', 'I')); // sig byte + "HI"
		put(ph, 5, alphaWord('!'.charCodeAt(0), 'A'.charCodeAt(0), 'B'.charCodeAt(0)));

		const msgs = decodePhase(ph, 'A', FIW);
		expect(msgs.length).toBe(1);
		expect(msgs[0].capcode).toBe(capcode);
		expect(msgs[0].kind).toBe('ALPHA');
		expect(msgs[0].text).toBe('HI!AB');
		expect(msgs[0].long).toBe(false);
		expect(msgs[0].phase).toBe('A');
		expect(msgs[0].cycle).toBe(3);
		expect(msgs[0].frame).toBe(42);
		expect(msgs[0].complete).toBe(true);
	});

	it('validates the alpha signature and K checksum on a complete message', () => {
		// Build a complete short-address alpha "HI!" (one data word after the
		// header), then compute the correct signature and K and inject them.
		const buildFrame = (sig, kVal) => {
			const ph = makePhase();
			put(ph, 0, biw(1, 2));
			put(ph, 1, 100000 + 32768);
			// hdr at 3 (carries K in bits 0-9), one data word at 4.
			const hdr = (alphaHdr('K') & ~0x3ff) | (kVal & 0x3ff);
			put(ph, 2, vector(0x5, 3, 2)); // body words 3..4
			put(ph, 3, hdr);
			put(ph, 4, sigWord(sig, 'H', 'I')); // sig + "HI"
			return ph;
		};
		// Signature = ~(sum of chars) & 0x7F; chars are 'H','I'.
		const sigSum = ('H'.charCodeAt(0) + 'I'.charCodeAt(0)) & 0x7f;
		const goodSig = ~sigSum & 0x7f;
		// K = ~(group sum over body words, header K field zeroed) & 0x3FF.
		const groups = (dw) => (dw & 0xff) + ((dw >> 8) & 0xff) + ((dw >> 16) & 0x1f);
		// Need the encoded 21-bit words as the decoder sees them (post-BCH info).
		// hdr info = alphaHdr('K') with K zeroed; data word = sigWord(goodSig,...).
		const hdrInfo = alphaHdr('K') & ~0x3ff;
		const dataInfo = sigWord(goodSig, 'H', 'I');
		const kSum = (groups(hdrInfo) + groups(dataInfo)) & 0x3ff;
		const goodK = ~kSum & 0x3ff;

		const ok = decodePhase(buildFrame(goodSig, goodK), 'A', FIW);
		expect(ok.length).toBe(1);
		expect(ok[0].text).toBe('HI');
		expect(ok[0].sigOk).toBe(true);
		expect(ok[0].kOk).toBe(true);

		// Wrong signature + wrong K -> both report false.
		const bad = decodePhase(buildFrame((goodSig ^ 0x7f) & 0x7f, (goodK ^ 0x3ff) & 0x3ff), 'A', FIW);
		expect(bad[0].sigOk).toBe(false);
		expect(bad[0].kOk).toBe(false);

		// A lost body word makes signature + K unverifiable -> both null,
		// never a spurious pass/fail (osmocom reports sig/K=incomplete).
		const incomplete = buildFrame(goodSig, goodK);
		incomplete.words[4] = 0x0f0f0f0f; // many bit errors -> BCH uncorrectable
		incomplete.altWords[4] = 0x0f0f0f0f; // defeat the I&D alt-word fallback too
		const inc = decodePhase(incomplete, 'A', FIW);
		expect(inc[0].sigOk).toBe(null);
		expect(inc[0].kOk).toBe(null);
	});

	it('decodes a standard numeric (BCD) message', () => {
		const ph = makePhase();
		const capcode = 555000;
		put(ph, 0, biw(1, 2));
		put(ph, 1, capcode + 32768);
		// NUMERIC vector: 3-bit length field. len = ((n)&7)+1; use 2 words.
		put(ph, 2, vector(0x3, 3, 1)); // len = 1+1 = 2 words (n field=1)
		// BCD nibbles LSB-first after 2 overhead bits in the first word.
		// Encode digits "12345" -> nibbles 1,2,3,4,5.
		// Word layout: bits0-1 overhead, then nibble0 at bits2-5, nibble1 6-9, ...
		const packNum = (nibbles, overhead) => {
			let w = 0;
			let bit = overhead;
			for (const nib of nibbles) {
				w |= (nib & 0x0f) << bit;
				bit += 4;
			}
			return w & 0x1fffff;
		};
		put(ph, 3, packNum([1, 2, 3, 4], 2)); // 4 digits fit (2+16=18 bits)
		put(ph, 4, packNum([5], 0)); // continues LSB-first, no overhead on later words

		const msgs = decodePhase(ph, 'A', FIW);
		expect(msgs.length).toBe(1);
		expect(msgs[0].capcode).toBe(capcode);
		expect(msgs[0].kind).toBe('NUM');
		expect(msgs[0].text.startsWith('1234')).toBe(true);
	});

	it('decodes BCD control characters (space, hyphen, brackets)', () => {
		const ph = makePhase();
		put(ph, 0, biw(1, 2));
		put(ph, 1, 100000 + 32768);
		put(ph, 2, vector(0x3, 3, 0)); // len = 1 word
		// C=space, D=hyphen, E=], F=[
		const w = (0xc << 2) | (0xd << 6) | (0xe << 10) | (0xf << 14);
		put(ph, 3, w & 0x1fffff);
		const msgs = decodePhase(ph, 'A', FIW);
		expect(msgs[0].text).toBe(' -][');
	});

	it('decodes an alpha message as 16-bit Kanji when the Kanji charset is active', () => {
		// Kanji charset switches extraction to one 16-bit char per word; the
		// signature word is skipped. kanji=true selects it.
		const ph = makePhase();
		put(ph, 0, biw(1, 2));
		put(ph, 1, 42 + 32768);
		put(ph, 2, vector(0x5, 3, 3)); // ALPHA, body at 3..5 (hdr + sig word + 1 kanji word)
		put(ph, 3, alphaHdr('K'));
		put(ph, 4, 0x3042 & 0x1fffff); // sig word (skipped in kanji mode too)
		put(ph, 5, 0x889f & 0x1fffff); // Shift-JIS 0x889F = U+4E9C (the kanji, big-endian bytes 0x88,0x9F)
		const kanji = decodePhase(ph, 'A', FIW, 1, true);
		expect(kanji.length).toBe(1);
		expect(kanji[0].kind).toBe('ALPHA:KNJ');
		// start word (4) is the signature word -> skipped; word 5 is a 16-bit
		// Shift-JIS code transcoded to Unicode (NOT taken as a code point).
		const expected = new TextDecoder('shift-jis').decode(new Uint8Array([0x88, 0x9f]));
		expect(kanji[0].text).toBe(expected);
		expect(kanji[0].text).not.toBe(String.fromCharCode(0x889f)); // must transcode, not map directly
		// Same frame in ASCII mode extracts 7-bit chars instead (different text).
		const ascii = decodePhase(ph, 'A', FIW, 1, false);
		expect(ascii[0].kind).toBe('ALPHA');
		expect(ascii[0].text).not.toBe(kanji[0].text);
	});

	it('applies a selected codepage to plain alpha, falling back to ASCII when unmapped', () => {
		// Alpha message "ABC" (0x41,0x42,0x43). Decode once as ASCII, once with a
		// codepage that remaps only 0x41 -> a glyph; 0x42/0x43 fall back to ASCII.
		const ph = makePhase();
		put(ph, 0, biw(1, 2));
		put(ph, 1, 123 + 32768);
		put(ph, 2, vector(0x5, 3, 2)); // ALPHA, body 3..4 (hdr word + 1 data word)
		put(ph, 3, alphaHdr('K')); // complete, unfragmented
		put(ph, 4, alphaWord(0x41, 0x41, 0x41));
		const ascii = decodePhase(ph, 'A', FIW);
		// Codepage: index = 7-bit code; only 0x41 ('A') overridden to Cyrillic Ya.
		const cp = new Array(128).fill(null);
		for (let c = 0x20; c <= 0x7e; c++) cp[c] = String.fromCharCode(c);
		cp[0x41] = '\u042f';
		const mapped = decodePhase(ph, 'A', FIW, 1, false, undefined, undefined, undefined, undefined, undefined, 0, cp);
		// Same bytes, but every 'A' in the ASCII decode becomes Cyrillic Ya, and
		// all other chars (ASCII fallback) are unchanged.
		expect(ascii[0].text.includes('A')).toBe(true);
		expect(mapped[0].text).toBe(ascii[0].text.replace(/A/g, '\u042f'));
		expect(mapped[0].text).not.toBe(ascii[0].text);
	});

	it('decodes a secure message: alpha sub-type as text, binary sub-type as hex', () => {
		// Secure alpha (t1t0=00): 7-bit text.
		const sa = makePhase();
		put(sa, 0, biw(1, 2));
		put(sa, 1, 7000 + 32768);
		put(sa, 2, vector(0x0, 3, 2)); // SECURE, body 3..4
		put(sa, 3, 0); // header: sub-type bits 19-20 = 00 (alpha)
		put(sa, 4, alphaWord('O'.charCodeAt(0), 'K'.charCodeAt(0), 0x03));
		const alpha = decodePhase(sa, 'A', FIW);
		expect(alpha[0].kind).toBe('SECURE:ALN');
		expect(alpha[0].text).toBe('OK');

		// Secure binary (t1t0=10 -> bit 20 set), initial fragment (F=11): word 3
		// is Header-2 (control + sub-type), skipped; data is word 4 only.
		const sb = makePhase();
		put(sb, 0, biw(1, 2));
		put(sb, 1, 7001 + 32768);
		put(sb, 2, vector(0x0, 3, 2));
		// header: sub-type = 10 (binary, bit 20) + F=11 initial (bits 11-12).
		put(sb, 3, (1 << 20) | (3 << 11));
		put(sb, 4, 0x0abcde & 0x1fffff);
		const bin = decodePhase(sb, 'A', FIW);
		expect(bin[0].kind).toBe('SECURE:BIN');
		// Uppercase nibble stream (no spaces), data word only (hdr2 skipped).
		expect(/^[0-9A-F?]+$/.test(bin[0].text)).toBe(true);
		// The control word (0x100000) must NOT appear as leading data nibbles.
		expect(bin[0].text.startsWith('00000')).toBe(false);
	});

	it('decodes a tone-only short-message vector (all-space digits)', () => {
		const ph = makePhase();
		const capcode = 42;
		put(ph, 0, biw(1, 2));
		put(ph, 1, capcode + 32768);
		// Short Message Vector (type 2), sub-type 00, all three BCD digits =
		// space (0x0C at bits 9/13/17) -> tone-only alert.
		const toneWord = (0x2 << 4) | (0x0c << 9) | (0x0c << 13) | (0x0c << 17);
		put(ph, 2, toneWord);
		const msgs = decodePhase(ph, 'A', FIW);
		expect(msgs.length).toBe(1);
		expect(msgs[0].kind).toBe('TONE');
		expect(msgs[0].text).toBe('');
		expect(msgs[0].capcode).toBe(capcode);
	});

	it('decodes a short-message numeric vector (3 BCD digits)', () => {
		const ph = makePhase();
		const capcode = 77;
		put(ph, 0, biw(1, 2));
		put(ph, 1, capcode + 32768);
		// Type 2, sub-type 00, digits 1/2/3 (BCD 1,2,3 at bits 9/13/17).
		const numWord = (0x2 << 4) | (1 << 9) | (2 << 13) | (3 << 17);
		put(ph, 2, numWord);
		const msgs = decodePhase(ph, 'A', FIW);
		expect(msgs.length).toBe(1);
		expect(msgs[0].kind).toBe('SMSG:NUM');
		expect(msgs[0].text).toBe('123');
	});

	it('recovers a message through a BCH-correctable single-bit error', () => {
		const ph = makePhase();
		const capcode = 1234567;
		put(ph, 0, biw(1, 2));
		put(ph, 1, capcode + 32768);
		put(ph, 2, vector(0x5, 3, 2)); // hdr at 3, text at 4
		put(ph, 3, alphaHdr('K'));
		put(ph, 4, sigWord(0x11, 'O', 'K')); // sig byte + "OK"
		// Flip one bit in the text word; the decoder BCH-corrects it (single-bit
		// errors are correctable), so the text still comes out clean.
		ph.words[4] ^= 1 << 5;
		const msgs = decodePhase(ph, 'A', FIW);
		expect(msgs.length).toBe(1);
		expect(msgs[0].text).toBe('OK');
	});

	it('reassembles a multi-fragment alpha message across frames', () => {
		const dec = new FlexFrameDecoder();
		const capcode = 2468;
		const N = 7;
		// Fragment 1 of 2 (F continued): "FOO"
		const p1 = [makePhase(), makePhase(), makePhase(), makePhase()];
		put(p1[0], 0, biw(1, 2));
		put(p1[0], 1, capcode + 32768);
		put(p1[0], 2, vector(0x5, 3, 2)); // hdr + 1 text word
		put(p1[0], 3, alphaHdr('F', N, 0)); // continued
		put(p1[0], 4, alpha('FOO'));
		const fiw1 = { ...FIW, cycle: 0, frame: 1 };
		let out = dec.decode(p1, [0], fiw1, 0);
		// B1: the partial is emitted in place (not held) so the UI shows it
		// building up; complete=false with a stable reasmKey, text so far.
		expect(out.length).toBe(1);
		expect(out[0].complete).toBe(false);
		expect(out[0].text).toBe('FOO');
		expect(out[0].reasmKey).toBeTruthy();
		const partialKey = out[0].reasmKey;

		// Fragment 2 of 2 (C final): "BAR"
		const p2 = [makePhase(), makePhase(), makePhase(), makePhase()];
		put(p2[0], 0, biw(1, 2));
		put(p2[0], 1, capcode + 32768);
		put(p2[0], 2, vector(0x5, 3, 2));
		put(p2[0], 3, alphaHdr('C', N, 1)); // final fragment (C=0, F!=11)
		put(p2[0], 4, alpha('BAR'));
		const fiw2 = { ...FIW, cycle: 0, frame: 2 };
		out = dec.decode(p2, [0], fiw2, 0);
		expect(out.length).toBe(1);
		expect(out[0].capcode).toBe(capcode);
		expect(out[0].text).toBe('FOOBAR');
		expect(out[0].complete).toBe(true);
		expect(out[0].reasmKey).toBe(partialKey); // same row updates in place
	});

	it('combines two transmission copies, recovering an uncorrectable word', () => {
		// 2x transmission: subframe is 44 words; copy 0 at [0..43], copy 1 at
		// [44..87]. Corrupt a message word in copy 0; copy 1 is clean, so the
		// best-of combine recovers it.
		const ph = makePhase();
		const capcode = 999;
		const buildCopy = (off) => {
			put(ph, off + 0, biw(1, 2));
			put(ph, off + 1, capcode + 32768);
			put(ph, off + 2, vector(0x5, 3, 2));
			put(ph, off + 3, alphaHdr('K'));
			put(ph, off + 4, sigWord(0x22, 'H', 'I')); // sig byte + "HI"
		};
		buildCopy(0);
		buildCopy(44);
		// Corrupt copy 0's text word beyond BCH repair; copy 1 stays clean.
		ph.words[4] ^= 0x0005a5a5;
		const fiw = { ...FIW, numTransmissions: 2 };
		const msgs = decodePhase(ph, 'A', fiw, 2);
		expect(msgs.some((m) => m.capcode === capcode && m.text === 'HI')).toBe(true);
	});

	it('skips an address whose word is uncorrectable', () => {
		const ph = makePhase();
		put(ph, 0, biw(1, 3)); // two address slots (1,2), vectors at 3
		put(ph, 1, 1234567 + 32768);
		put(ph, 2, 500000 + 32768);
		// Corrupt addr[1] with many bit errors so BCH genuinely cannot decode
		// it (the decoder recomputes status from the codeword, so flipping the
		// status flag alone would not make it uncorrectable).
		ph.words[1] ^= 0x0005a5a5;
		put(ph, 3, vector(0x2, 0, 0)); // vector for addr[2]
		put(ph, 4, vector(0x2, 0, 0));
		const msgs = decodePhase(ph, 'A', FIW);
		// addr[1] skipped; addr[2] -> capcode 500000.
		expect(msgs.some((m) => m.capcode === 500000)).toBe(true);
		expect(msgs.some((m) => m.capcode === 1234567)).toBe(false);
	});

	it('decodeFrame uses phase A only for 2FSK (phasesUsed=1)', () => {
		const phases = [makePhase(), makePhase(), makePhase(), makePhase()];
		put(phases[0], 0, biw(1, 2));
		put(phases[0], 1, 777 + 32768);
		put(phases[0], 2, vector(0x2, 0, 0));
		// Put a decoy in phase B; with phasesUsed=1 it must be ignored.
		put(phases[1], 0, biw(1, 2));
		put(phases[1], 1, 888 + 32768);
		put(phases[1], 2, vector(0x2, 0, 0));
		const msgs = decodeFrame(phases, [0], FIW);
		expect(msgs.some((m) => m.capcode === 777)).toBe(true);
		expect(msgs.some((m) => m.capcode === 888)).toBe(false);
	});

	it('round-trips the FIW through encode/decode', () => {
		// cycle=5, frame=100, roaming=1, repeat=0, low-traffic t=0.
		const cycle = 5;
		const frame = 100;
		const roaming = 1;
		let data = (cycle << 4) | (frame << 8) | (roaming << 15);
		// Set the 4-bit checksum (x) so nibble-sum + bit20 == 0xF.
		const sum = ((data >> 4) & 0xf) + ((data >> 8) & 0xf) + ((data >> 12) & 0xf) + ((data >> 16) & 0xf) + ((data >> 20) & 1);
		const x = (0xf - (sum & 0xf)) & 0xf;
		data |= x;
		const fiw = decodeFiw(bchEncode(data & 0x1fffff));
		expect(fiw).not.toBeNull();
		expect(fiw.cycle).toBe(cycle);
		expect(fiw.frame).toBe(frame);
		expect(fiw.roaming).toBe(roaming);
	});

	it('decodes long addresses across all three sets (regression: BUG 1)', () => {
		// osmocom encode_long_address inverse: capcode -> (w1, w2) raw 21-bit
		// address words. Sets per frame.h FLEX_LONG_* bases/offsets.
		const SHORT = 32768;
		const encodeLong = (capcode) => {
			if (capcode >= 2101249 && capcode <= 1075843072) {
				const r = capcode - 2068481;
				return [(r % SHORT) + 1, 2097151 - Math.floor(r / SHORT)];
			}
			if (capcode >= 1075843073 && capcode <= 3223326720) {
				const r = capcode - 2068481;
				return [(r % SHORT) + 1, Math.floor(r / SHORT) + 1933312];
			}
			// Set 2-3
			const r = capcode - 2068479;
			return [(r % SHORT) + 2064383, Math.floor(r / SHORT) + 1867776];
		};
		for (const capcode of [2101249, 50000000, 1075843073, 2000000000, 3223326721]) {
			const ph = makePhase();
			const [w1, w2] = encodeLong(capcode);
			put(ph, 0, biw(1, 3)); // 2 address slots (long), vectors at 3
			put(ph, 1, w1);
			put(ph, 2, w2);
			put(ph, 3, vector(0x2, 0, 0)); // tone vector for the long address
			const msgs = decodePhase(ph, 'A', FIW);
			expect(msgs.length).toBe(1);
			expect(msgs[0].capcode).toBe(capcode);
			expect(msgs[0].long).toBe(true);
		}
	});

	it('decodes a long-address numeric as one continuous stream (regression: BUG 3)', () => {
		// Long address (set 1-2, capcode 2101249 -> w1=1, w2=2097150).
		const ph = makePhase();
		put(ph, 0, biw(1, 3)); // long addr at 1..2, vectors at 3
		put(ph, 1, 1); // w1 (LA1)
		put(ph, 2, 2097150); // w2 (LA2)
		// NUMERIC long: body[0] at Vy (word 4), MF words from mw1. The vector
		// start (b field) points at the MF start; len counts body words incl Vy.
		put(ph, 3, vector(0x3, 5, 1)); // NUMERIC, mw1=5, len=1+1=2; long -> mw2--=5
		// Vy word (body[0]) at word 4: 2 overhead bits, then digits 1,2,3,4.
		const pack = (nibbles, overhead) => {
			let w = 0;
			let bit = overhead;
			for (const n of nibbles) {
				w |= (n & 0x0f) << bit;
				bit += 4;
			}
			return w & 0x1fffff;
		};
		put(ph, 4, pack([1, 2, 3, 4], 2)); // Vy: skip 2, then 1234 (bits 2-17)
		// MF word 5 continues the SAME nibble stream (no second skip): digits 5,6.
		// Vy has 21 bits; after 2 skip, 19 bits -> 4 full nibbles (16 bits) + 3
		// leftover bits that carry into word 5. Build word 5 so the stream
		// continues cleanly: put the carry-completing bits then 9.
		put(ph, 5, pack([5, 6], 0));
		const msgs = decodePhase(ph, 'A', FIW);
		expect(msgs.length).toBe(1);
		expect(msgs[0].kind).toBe('NUM');
		expect(msgs[0].capcode).toBe(2101249);
		// First four digits come from the Vy word regardless of carry alignment.
		expect(msgs[0].text.startsWith('1234')).toBe(true);
	});

	it('bchEncode produces words that decode CLEAN', () => {
		for (const info of [0, 1, 0x155, 0x1fffff, 0x12345, 999999 & 0x1fffff]) {
			const r = bchDecode(bchEncode(info));
			expect(r.status).toBe(BCH_CLEAN_LOCAL);
			expect(r.info).toBe(info & 0x1fffff);
		}
	});

	it('reports BER 0 for a clean frame (idle fill words included)', () => {
		// A clean frame with idle fill (all-ones / all-zeros, both valid BCH
		// codewords) must read BER 0 -- idle words do not inflate the rate.
		const dec = new FlexFrameDecoder();
		const ph = [makePhase(), makePhase(), makePhase(), makePhase()];
		put(ph[0], 0, biw(1, 2));
		put(ph[0], 1, 1234 + 32768);
		put(ph[0], 2, vector(0x2, 0, 0)); // tone-only
		// Fill the rest with idle words (both valid BCH codewords, status CLEAN).
		for (let i = 3; i < WPF; i++) {
			ph[0].words[i] = i % 2 === 0 ? 0x00000000 : 0xffffffff;
			ph[0].status[i] = 1;
		}
		dec.decode(ph, [0], FIW, 0);
		expect(dec.getBer()).toBe(0);
	});

	it('counts the actual BCH-corrected bits in the BER', () => {
		// Flip one bit in one message word so BCH corrects exactly 1 bit. Every
		// word in the phase is a valid codeword (unfilled words are 0 = a valid
		// idle codeword), so all 88 are "received": the BER is 1 corrected bit
		// over (88 * 31) bits -- a small, sensible rate, not an inflated one.
		const dec = new FlexFrameDecoder();
		const ph = [makePhase(), makePhase(), makePhase(), makePhase()];
		put(ph[0], 0, biw(1, 2));
		put(ph[0], 1, 1234 + 32768);
		put(ph[0], 2, vector(0x5, 3, 1)); // alpha, one text word at 3
		put(ph[0], 3, alpha('HI!'));
		ph[0].words[3] ^= 0x00000010; // corrupt 1 bit -> BCH corrects it
		dec.decode(ph, [0], FIW, 0);
		expect(dec.getBer()).toBeCloseTo(1 / (WPF * 31), 6);
	});

	it('extracts numbered-numeric N / R / S flags (V=111)', () => {
		// Numbered header in body[0]: K5K4(0-1) N(2-7) R(8) S(9), digits from 10.
		const N = 5;
		const R = 1; // new message
		const S = 0; // standard (not special) -> NNUM
		const hdr = ((N & 0x3f) << 2) | ((R & 1) << 8) | ((S & 1) << 9);
		const ph = makePhase();
		put(ph, 0, biw(1, 2));
		put(ph, 1, 4242 + 32768);
		put(ph, 2, vector(0x7, 3, 1)); // NUMBERED_NUM, body at word 3
		put(ph, 3, hdr); // header word (digits all 0 after bit 10)
		const msgs = decodePhase(ph, 'A', FIW);
		expect(msgs.length).toBe(1);
		expect(msgs[0].kind).toBe('NNUM');
		expect(msgs[0].msgNumber).toBe(N);
		expect(msgs[0].isNew).toBe(true);
		expect(msgs[0].special).toBe(false);

		// S=1 -> NSNUM, R=0 -> retransmission.
		const ph2 = makePhase();
		put(ph2, 0, biw(1, 2));
		put(ph2, 1, 4243 + 32768);
		put(ph2, 2, vector(0x7, 3, 1));
		put(ph2, 3, ((9 & 0x3f) << 2) | (0 << 8) | (1 << 9));
		const m2 = decodePhase(ph2, 'A', FIW);
		expect(m2[0].kind).toBe('NSNUM');
		expect(m2[0].msgNumber).toBe(9);
		expect(m2[0].isNew).toBe(false);
		expect(m2[0].special).toBe(true);
	});

	it('extracts alpha mail-drop (M) and retrieval (R) flags on the first fragment', () => {
		// First fragment (F=11 -> hdrF=3): bit 19 = R, bit 20 = M.
		const ph = makePhase();
		put(ph, 0, biw(1, 2));
		put(ph, 1, 7777 + 32768);
		put(ph, 2, vector(0x5, 3, 2)); // ALPHA, hdr + 1 text word
		put(ph, 3, alphaHdr('K') | (1 << 19) | (1 << 20)); // R=1, M=1
		put(ph, 4, sigWord(0, 'H', 'I'));
		const msgs = decodePhase(ph, 'A', FIW);
		expect(msgs.length).toBe(1);
		expect(msgs[0].kind).toBe('ALPHA');
		expect(msgs[0].mailDrop).toBe(true);
		expect(msgs[0].retrieval).toBe(true);
	});

	it('does not decode an idle (all-zero) address word as a capcode', () => {
		// Address word 1 is 0 (idle fill): classifyAddress -> unknown, skipped.
		// Previously this produced a bogus capcode of -32768.
		const ph = makePhase();
		put(ph, 0, biw(1, 2));
		ph.words[1] = 0; // idle/invalid address word (not a valid short address)
		ph.status[1] = 1; // CLEAN but value 0 => unknown class
		put(ph, 2, vector(0x5, 3, 1));
		put(ph, 3, alpha('HI!'));
		const msgs = decodePhase(ph, 'A', FIW);
		expect(msgs.length).toBe(0); // no spurious negative-capcode message
	});

	it('classifies a temporary (group) capcode by address range', () => {
		// Address word in the temporary range (0x1F7800..0x1F780F) -> 'temporary'.
		const ph = makePhase();
		put(ph, 0, biw(1, 2));
		put(ph, 1, 0x1f7805); // temporary (group) address word
		put(ph, 2, vector(0x5, 3, 1));
		put(ph, 3, alpha('HI!'));
		const msgs = decodePhase(ph, 'A', FIW);
		expect(msgs.length).toBe(1);
		expect(msgs[0].capClass).toBe('temporary');
	});

	it('marks BCH-corrected characters in charStatus (recovered)', () => {
		const ph = makePhase();
		put(ph, 0, biw(1, 2));
		put(ph, 1, 4242 + 32768);
		put(ph, 2, vector(0x5, 3, 2)); // ALPHA, hdr at 3, text at 4
		put(ph, 3, alphaHdr('K'));
		put(ph, 4, sigWord(0, 'A', 'B')); // sig + "AB"
		ph.words[4] ^= 1 << 25; // corrupt 1 parity bit -> text word decodes CORRECTED, info intact
		const msgs = decodePhase(ph, 'A', FIW);
		expect(msgs.length).toBe(1);
		expect(msgs[0].text).toBe('AB');
		// Both chars came from a corrected word -> status 1 (recovered).
		expect(msgs[0].charStatus).toEqual([1, 1]);
	});

	it('tracks temp-group slot state from assignment and delivery', () => {
		const dec = new FlexFrameDecoder();
		// Short-instruction type 000: assign capcode to slot 3, target frame 42.
		// Instruction data (14 bits, bits 7-20 of the vector word): type(0-2)=000,
		// frame(3-9), slot(10-13). Build the 14-bit value then shift into bits 7+.
		const SLOT = 3;
		const TARGET = 42;
		const instrData = (0 & 0x7) | ((TARGET & 0x7f) << 3) | ((SLOT & 0xf) << 10);
		const instrViw = ((0x1 & 0x7) << 4) | ((instrData & 0x3fff) << 7); // V=001 + data
		const p1 = [makePhase(), makePhase(), makePhase(), makePhase()];
		put(p1[0], 0, biw(1, 2));
		put(p1[0], 1, 5000 + 32768); // ordinary short capcode (the group member)
		put(p1[0], 2, instrViw); // short-instruction vector
		dec.decode(p1, [0], { ...FIW, cycle: 0, frame: 1 }, 0);
		let slots = dec.getGroupSlots(0);
		expect(slots[SLOT].state).toBe('registered');
		expect(slots[SLOT].targetFrame).toBe(TARGET);
		expect(slots[SLOT].members).toContain(5000);

		// Deliver to the temporary address for slot 3 (0x1F7800 + 3).
		const tempAw = 0x1f7800 + SLOT;
		const p2 = [makePhase(), makePhase(), makePhase(), makePhase()];
		put(p2[0], 0, biw(1, 2));
		put(p2[0], 1, tempAw);
		put(p2[0], 2, vector(0x5, 3, 1)); // alpha to the group
		put(p2[0], 3, alpha('HI!'));
		dec.decode(p2, [0], { ...FIW, cycle: 0, frame: 2 }, 0);
		slots = dec.getGroupSlots(0);
		expect(slots[SLOT].state).toBe('delivering');
		// The delivery message carries the members learned from the assignment.
		const deliver = dec.decode(p2, [0], { ...FIW, cycle: 0, frame: 2 }, 0);
		expect(deliver[0].capClass).toBe('temporary');
		expect(deliver[0].groupMembers).toContain(5000);
	});

	it('flags a reassembled message incomplete on an F-sequence gap', () => {
		const dec = new FlexFrameDecoder();
		const capcode = 3131;
		const N = 4;
		const mk = (flag, fragNum, word) => {
			const p = [makePhase(), makePhase(), makePhase(), makePhase()];
			put(p[0], 0, biw(1, 2));
			put(p[0], 1, capcode + 32768);
			put(p[0], 2, vector(0x5, 3, 2));
			put(p[0], 3, alphaHdr(flag, N, fragNum));
			put(p[0], 4, alpha(word));
			return p;
		};
		// Initial (F=11) then jump straight to the FINAL with F=1 (expected 0):
		// a middle fragment was lost -> fMismatch -> emitted incomplete.
		dec.decode(mk('F', N, 3), [0], { ...FIW, cycle: 0, frame: 1 }, 0); // initial
		const out = dec.decode(mk('C', N, 1), [0], { ...FIW, cycle: 0, frame: 2 }, 0); // F=1, gap
		const final = out.find((m) => m.complete);
		expect(final).toBeTruthy();
		expect(final.incomplete).toBe(true);
		expect(final.text).toContain('<...>'); // visible gap marker
	});

	it('emits an incomplete partial when a fragment stream times out', () => {
		const dec = new FlexFrameDecoder();
		const capcode = 777;
		const p1 = [makePhase(), makePhase(), makePhase(), makePhase()];
		put(p1[0], 0, biw(1, 2));
		put(p1[0], 1, capcode + 32768);
		put(p1[0], 2, vector(0x5, 3, 2));
		put(p1[0], 3, alphaHdr('F', 9, 0)); // continued, never finished
		put(p1[0], 4, alpha('ABC'));
		dec.decode(p1, [0], { ...FIW, cycle: 0, frame: 1 }, 0);
		// Advance well past the 128-frame timeout (next cycle) with an empty frame.
		const empty = [makePhase(), makePhase(), makePhase(), makePhase()];
		put(empty[0], 0, biw(1, 2));
		const out = dec.decode(empty, [0], { ...FIW, cycle: 2, frame: 10 }, 0);
		const partial = out.find((m) => m.incomplete);
		expect(partial).toBeTruthy();
		expect(partial.text).toContain('ABC'); // the partial content is printed
		expect(partial.complete).toBe(true); // emitted as a (valid) finished row
	});

	it('decodes a HEX/Binary vector (type 6), skipping the Header-2 control word', () => {
		const ph = makePhase();
		const capcode = 5150;
		put(ph, 0, biw(1, 2));
		put(ph, 1, capcode + 32768);
		put(ph, 2, vector(0x6, 3, 2)); // HEX, body 3..4
		// hdr at word 3: F=11 (initial, bits 11-12). Word 3 is Header-2, skipped.
		put(ph, 3, 3 << 11);
		// Data word: nibbles LSB-first. 0x00ABCD -> stream rendered uppercase hex.
		put(ph, 4, 0x00abcd & 0x1fffff);
		const msgs = decodePhase(ph, 'A', FIW);
		expect(msgs.length).toBe(1);
		expect(msgs[0].kind).toBe('HEX');
		// Only data (word 4) contributes; the control word (3<<11) is not data.
		expect(/^[0-9A-F?]+$/.test(msgs[0].text)).toBe(true);
		expect(msgs[0].text.length).toBeGreaterThan(0);
	});

	it('decodes a Short Message Network-ID on a network address', () => {
		const ph = makePhase();
		// Network address range (0x1F6800..0x1F77FF per classifier) -> capClass 'network'.
		const netAw = 0x1f6900;
		put(ph, 0, biw(1, 2));
		put(ph, 1, netAw);
		// Type 2, sub-type 00: area=5 (bits 9-13), mult=2 (14-16), tmf=3 (17-20).
		const nidWord = (0x2 << 4) | (5 << 9) | (2 << 14) | (3 << 17);
		put(ph, 2, nidWord);
		const msgs = decodePhase(ph, 'A', FIW);
		expect(msgs.length).toBe(1);
		expect(msgs[0].capClass).toBe('network');
		expect(msgs[0].kind).toBe('SMSG:NID');
		expect(msgs[0].text).toContain('area=5');
	});

	it('tags an exact retransmission of a complete message as a duplicate', () => {
		const dec = new FlexFrameDecoder();
		const cap = 1234567;
		const build = () => {
			const ph = [makePhase(), makePhase(), makePhase(), makePhase()];
			put(ph[0], 0, biw(1, 2));
			put(ph[0], 1, cap + 32768);
			put(ph[0], 2, vector(0x5, 3, 3)); // ALPHA, hdr at 3, text 4..5
			put(ph[0], 3, alphaHdr('K'));
			put(ph[0], 4, sigWord(0x42, 'H', 'I'));
			put(ph[0], 5, alphaWord('!'.charCodeAt(0), 0x03, 0x03));
			return ph;
		};
		const first = dec.decode(build(), [0], { ...FIW, cycle: 0, frame: 1 }, 0);
		expect(first[0].dedup).toBeUndefined(); // first copy: new
		expect(first[0].text).toBe('HI!');
		const second = dec.decode(build(), [0], { ...FIW, cycle: 0, frame: 2 }, 0);
		expect(second[0].dedup).toBe('dup'); // exact retransmission tagged, still emitted
		expect(second[0].text).toBe('HI!');
	});

	it('recovers a lost word from a cleaner retransmission (dup+ word combine)', () => {
		const dec = new FlexFrameDecoder();
		const cap = 7654321;
		// First transmission: the text word (5) is BCH-uncorrectable (3 bit
		// errors -- past the t=2 correction limit). bchDecodePhase re-decodes
		// raw words, so corruption must be in the raw codeword, not the status.
		const t1 = [makePhase(), makePhase(), makePhase(), makePhase()];
		put(t1[0], 0, biw(1, 2));
		put(t1[0], 1, cap + 32768);
		put(t1[0], 2, vector(0x5, 3, 3));
		put(t1[0], 3, alphaHdr('K'));
		put(t1[0], 4, sigWord(0x42, 'H', 'I'));
		put(t1[0], 5, alphaWord('!'.charCodeAt(0), 0x03, 0x03));
		t1[0].words[5] ^= 0b111; // 3-bit error -> uncorrectable
		t1[0].altWords[5] = t1[0].words[5]; // I&D fallback also corrupt (else it recovers 0)
		const first = dec.decode(t1, [0], { ...FIW, cycle: 0, frame: 1 }, 0);
		expect(first[0].text).toContain('?'); // the lost word shows as placeholder(s)

		// Retransmission: word 5 arrives clean -> merged in, re-decoded.
		const t2 = [makePhase(), makePhase(), makePhase(), makePhase()];
		put(t2[0], 0, biw(1, 2));
		put(t2[0], 1, cap + 32768);
		put(t2[0], 2, vector(0x5, 3, 3));
		put(t2[0], 3, alphaHdr('K'));
		put(t2[0], 4, sigWord(0x42, 'H', 'I'));
		put(t2[0], 5, alphaWord('!'.charCodeAt(0), 0x03, 0x03));
		const second = dec.decode(t2, [0], { ...FIW, cycle: 0, frame: 2 }, 0);
		expect(second[0].dedup).toBe('dup+'); // improved retransmission
		expect(second[0].text).toBe('HI!'); // recovered via word combine
	});

	it('does not trust a BIW TIME until 3 readings agree (consistency voting)', () => {
		const dec = new FlexFrameDecoder();
		// BIW TIME word: type 010, hour 10 (7-11), min 12 (12-17), sec 0 (18-20).
		// FIW cycle 3 => minute window [12..15], so min 12 passes the cross-check.
		const timeWord = (0x2 << 4) | (10 << 7) | (12 << 12) | (0 << 18);
		const frame = () => {
			const ph = [makePhase(), makePhase(), makePhase(), makePhase()];
			put(ph[0], 0, biw(2, 3)); // aoffset 2 -> word 1 is a BIW extra word
			put(ph[0], 1, timeWord);
			return ph;
		};
		dec.decode(frame(), [0], { ...FIW, cycle: 3, frame: 0 }, 0);
		expect(dec.getNetInfo().time).toBeNull(); // 1 reading: not yet trusted
		dec.decode(frame(), [0], { ...FIW, cycle: 3, frame: 1 }, 0);
		expect(dec.getNetInfo().time).toBeNull(); // 2 readings: still not trusted
		dec.decode(frame(), [0], { ...FIW, cycle: 3, frame: 2 }, 0);
		expect(dec.getNetInfo().time).toBe('10:12:00'); // 3 agree -> confirmed
	});

	it('expires a confirmed clock component after a full cycle without refresh', () => {
		const dec = new FlexFrameDecoder();
		const timeWord = (0x2 << 4) | (10 << 7) | (12 << 12) | (0 << 18);
		const tframe = () => {
			const ph = [makePhase(), makePhase(), makePhase(), makePhase()];
			put(ph[0], 0, biw(2, 3));
			put(ph[0], 1, timeWord);
			return ph;
		};
		// Confirm time at cycle 3 (3 agreeing readings).
		for (let f = 0; f < 3; f++) dec.decode(tframe(), [0], { ...FIW, cycle: 3, frame: f }, 0);
		expect(dec.getNetInfo().time).toBe('10:12:00');

		// Advance frames with no TIME word (empty BIW frames) past a full cycle
		// (1920 frames). The monotonic counter crosses cycle wraps; once the gap
		// reaches a full cycle the confirmed time is expired.
		const empty = () => {
			const ph = [makePhase(), makePhase(), makePhase(), makePhase()];
			put(ph[0], 0, biw(1, 2)); // address field, no BIW extra words
			return ph;
		};
		// Walk ~17 cycles of frames (well over 1920) so the mono gap exceeds a cycle.
		for (let c = 4; c < 15; c++) dec.decode(empty(), [0], { ...FIW, cycle: c, frame: 0 }, 0);
		for (let c = 0; c < 10; c++) dec.decode(empty(), [0], { ...FIW, cycle: c, frame: 0 }, 0);
		expect(dec.getNetInfo().time).toBeNull(); // stale -> expired
	});

	it('corrects the 5-bit year field rollover after 2025 (DATE voting)', () => {
		const dec = new FlexFrameDecoder();
		// year_raw 0 => 1994; with the current year >= 2026 it rolls to 2026.
		// DATE word: type 001, year_raw 0 (7-11), day 1 (12-16), month 1 (17-20).
		const dateWord = (0x1 << 4) | (0 << 7) | (1 << 12) | (1 << 17);
		const frame = () => {
			const ph = [makePhase(), makePhase(), makePhase(), makePhase()];
			put(ph[0], 0, biw(2, 3));
			put(ph[0], 1, dateWord);
			return ph;
		};
		for (let f = 0; f < 3; f++) dec.decode(frame(), [0], { ...FIW, cycle: 0, frame: f }, 0);
		const date = dec.getNetInfo().date;
		// Reproduce correctYearRollover: start at 1994, add 32 while >16y behind.
		let expectedYear = 1994;
		const curYear = new Date().getUTCFullYear();
		while (expectedYear + 16 < curYear) expectedYear += 32;
		expect(date).toBe(`${expectedYear}-01-01`);
		expect(Number(date.slice(0, 4))).toBeGreaterThanOrEqual(2026);
	});

	it('does not desync the vector index when an idle address sits between pages', () => {
		// Address field (words 1-4), vector field from word 5. Two valid short
		// pages with an IDLE address word between them. An idle/unknown address
		// has NO vector, so it must advance the address index only -- not the
		// vector count. Before the fix it advanced both, so the second page read
		// the wrong vector word (observed: a later page decoding as the wrong
		// type in dense frames). Regression for the 8-member group SETUP bug.
		const ph = makePhase();
		put(ph, 0, biw(1, 5)); // address field 1..4, vectors at 5+
		put(ph, 1, 1000 + 32768); // page 1: short address
		ph.words[2] = 0; // idle address word (no vector)
		ph.status[2] = 1;
		put(ph, 3, 2000 + 32768); // page 2: short address
		put(ph, 5, vector(0x5, 7, 2)); // page 1 vector -> hdr 7, text 8
		put(ph, 6, vector(0x5, 9, 2)); // page 2 vector -> hdr 9, text 10 (word 7 if desynced)
		put(ph, 7, alphaHdr('K'));
		put(ph, 8, sigWord(0x42, 'P', '1'));
		put(ph, 9, alphaHdr('K'));
		put(ph, 10, sigWord(0x42, 'P', '2'));
		const msgs = decodePhase(ph, 'A', FIW);
		const p1 = msgs.find((m) => m.capcode === 1000);
		const p2 = msgs.find((m) => m.capcode === 2000);
		expect(p1).toBeTruthy();
		expect(p2).toBeTruthy();
		expect(p1.kind).toBe('ALPHA'); // page 1 reads vector at word 5
		expect(p2.kind).toBe('ALPHA'); // page 2 reads vector at word 6 (not desynced to 7)
		expect(p1.text).toBe('P1');
		expect(p2.text).toBe('P2');
	});

	it('decodes system-event flags at the standard bit positions (e0-e10 at bits 10-20)', () => {
		// Short Instruction Vector (ARIB Table 3.9.6-1): vector type 001 (bits
		// 4-6), instruction type 001 = system event (bits 7-9), 11 event flags
		// e0-e10 at d0-d10 (bits 10-20). Set e0 (SSID-TMF) and e4 (new-SSID-freq).
		const flags = (1 << 0) | (1 << 4);
		const viw = (0x1 << 4) | (0x1 << 7) | (flags << 10);
		const text = describeInstruction(viw);
		expect(text).toContain('SSID-TMF-split'); // e0
		expect(text).toContain('new-SSID-freq'); // e4
		expect(text).not.toContain('NID-TMF-split'); // e1 not set
		expect(text).not.toContain('channel-setup-change'); // e2 not set

		// e10 (top flag, bit 20) must be reachable -- the reference multimon-ng
		// drops it with a >>9 off-by-one; our >>10 keeps the full 11-bit field.
		const e10only = (0x1 << 4) | (0x1 << 7) | (1 << 20);
		expect(describeInstruction(e10only)).toBe('system event'); // e10 reserved, no name, but no crash/misread
	});

	it('formats the calculated flextime only from confirmed components', () => {
		const base = { localId: null, coverageZone: null, countryCode: null, tmf: null, dst: null };
		const clk = (over) => ({
			year: null,
			month: null,
			day: null,
			hour: 15,
			min: 42,
			coarseSec: 0,
			extSec: null,
			standardMode: false,
			...over,
		});
		// Nothing confirmed -> no timestamp printed at all.
		expect(formatFlexTime({ ...base, date: null, time: null, tzOffsetMin: null, clock: null }, 0)).toBeNull();
		// Date only (no clock).
		expect(formatFlexTime({ ...base, date: '2026-10-26', time: null, tzOffsetMin: null, clock: null }, 0)).toBe('2026-10-26');
		// Date + time + whole-hour TZ (DIRECT mode: no frame offset).
		expect(formatFlexTime({ ...base, date: '2026-10-26', time: '15:42:00', tzOffsetMin: 120, dst: false, clock: clk({}) }, 50)).toBe(
			'2026-10-26 15:42:00 +2h',
		);
		// Fractional-hour TZ with DST active, negative offset (DIRECT).
		expect(
			formatFlexTime({ ...base, date: null, time: '09:30:00', tzOffsetMin: -330, dst: true, clock: clk({ hour: 9, min: 30 }) }, 0),
		).toBe('09:30:00 -5h30m DST');
	});

	it('adds the per-frame offset in STANDARD mode but not DIRECT (time-mode vote)', () => {
		const base = { localId: null, coverageZone: null, countryCode: null, tmf: null, dst: null, date: null, tzOffsetMin: null };
		const clk = (standardMode) => ({ year: null, month: null, day: null, hour: 10, min: 0, coarseSec: 0, extSec: null, standardMode });
		// STANDARD: TIME is Frame-0 time; frame 40 adds 40 * 1.875 = 75 s -> 10:01:15.
		expect(formatFlexTime({ ...base, time: '10:00:00', clock: clk(true) }, 40)).toBe('10:01:15');
		// DIRECT: TIME already carries the frame's instant; no offset -> 10:00:00.
		expect(formatFlexTime({ ...base, time: '10:00:00', clock: clk(false) }, 40)).toBe('10:00:00');
		// STANDARD with extended seconds (coarse 2 = 15 s, ext 3 = 2.8125 s) at
		// frame 0: 15 + 2.8125 = 17 s (truncated).
		const clkExt = { year: null, month: null, day: null, hour: 10, min: 0, coarseSec: 2, extSec: 3, standardMode: true };
		expect(formatFlexTime({ ...base, time: '10:00:15', clock: clkExt }, 0)).toBe('10:00:17');
	});

	it('verifies the numeric 6-bit K checksum (ARIB 3.10.1.1.1)', () => {
		// Two body words (short-address numeric). Compute the K the same way the
		// decoder does, place K3-K0 in the vector word (bits 17-20) and K5K4 in
		// body0 (bits 0-1), and confirm it verifies; then corrupt a data bit.
		const words = new Uint32Array(88);
		const status = new Int8Array(88).fill(1); // all CLEAN
		const j = 2; // vector word index
		const body = [3, 4]; // body0 at 3, one more data word at 4
		words[3] = 0x123450 & ~0x03; // body0 data (K5K4 zeroed for the sum)
		words[4] = 0x0abcde;
		// Recompute K over the body words (K5K4 already zero in body0).
		let kSum = 0;
		for (const w of body) {
			kSum += words[w] & 0xff;
			kSum += (words[w] >> 8) & 0xff;
			kSum += (words[w] >> 16) & 0x1f;
		}
		kSum &= 0xff;
		const k6 = ~((kSum & 0x3f) + (kSum >> 6)) & 0x3f;
		words[3] |= (k6 >> 4) & 0x03; // K5K4 into body0 bits 0-1
		words[j] = ((k6 & 0x0f) << 17) >>> 0; // K3-K0 into vector word bits 17-20
		expect(verifyNumericKChecksum(words, status, words[j], body)).toBe(true);

		// Corrupt a data bit -> checksum must now fail.
		words[4] ^= 0x10;
		expect(verifyNumericKChecksum(words, status, words[j], body)).toBe(false);

		// A lost body word cannot be verified -> null.
		status[4] = 3; // WORD_UNCORRECTABLE
		expect(verifyNumericKChecksum(words, status, words[j], body)).toBeNull();
	});
});

const BCH_CLEAN_LOCAL = 0;
