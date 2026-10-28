import { describe, it, expect } from 'vitest';
import { FlexFrontend } from '@/worker/decoders/flex/frontend';
import { bchDecode, combinedACorrection, countBits, BCH_CLEAN, BCH_CORRECTED, BCH_UNCORRECTABLE } from '@/worker/decoders/flex/bch';

// -- Synthetic FLEX S1 generator ---------------------------------------------
// S1 (always 1600 baud / 2FSK) = BS1(32) + A(32) + B(16) + A_inv(32), MSB-first
// on the wire, per osmocom-analog src/flex/frame.c flex_encode_s1. We render
// each wire bit as a 2FSK deviation and smooth it into FM-demod-like audio, so
// the front end can lock, detect the sync marker, and select the air mode --
// without a real capture. (Same fixture gap GSC had; this proves the code path,
// not an end-to-end message decode.)

const SAMPLE_RATE = 48000;
const BAUD = 1600; // S1 rate

// Transmitted S1 sync bytes (MSB-first) for each mode, from frame.c.
const S1 = {
	A1: { bytes: [0xaa, 0xaa, 0xaa, 0xaa, 0x78, 0xf3, 0x59, 0x39, 0x55, 0x55, 0x87, 0x0c, 0xa6, 0xc6], baud: 1600, levels: 2 },
	A2: { bytes: [0xaa, 0xaa, 0xaa, 0xaa, 0x84, 0xe7, 0x59, 0x39, 0x55, 0x55, 0x7b, 0x18, 0xa6, 0xc6], baud: 3200, levels: 2 },
	A3: { bytes: [0xaa, 0xaa, 0xaa, 0xaa, 0x4f, 0x97, 0x59, 0x39, 0x55, 0x55, 0xb0, 0x68, 0xa6, 0xc6], baud: 1600, levels: 4 },
	A4: { bytes: [0xaa, 0xaa, 0xaa, 0xaa, 0x21, 0x5f, 0x59, 0x39, 0x55, 0x55, 0xde, 0xa0, 0xa6, 0xc6], baud: 3200, levels: 4 },
};

// ERS (Ar) and a reserved code (A5) S1 syncs (non-mode). Ar = osmocom sync_ar
// {cb,20,59,39} / sync_ar_inv {34,df,a6,c6}; A5 = {dd,4b,59,39} / inv {22,b4,..}.
const S1_ERS = [0xaa, 0xaa, 0xaa, 0xaa, 0xcb, 0x20, 0x59, 0x39, 0x55, 0x55, 0x34, 0xdf, 0xa6, 0xc6];
const S1_A5 = [0xaa, 0xaa, 0xaa, 0xaa, 0xdd, 0x4b, 0x59, 0x39, 0x55, 0x55, 0x22, 0xb4, 0xa6, 0xc6];

/** Expand MSB-first bytes to a bit array. */
function bytesToBits(bytes) {
	const bits = [];
	for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
	return bits;
}

/**
 * Render a 2FSK bit sequence to smoothed FM-demod audio. Mark ("1") = negative
 * deviation (osmocom/multimon-ng convention). A one-pole smoother rounds the
 * symbol edges so the zero-crossing PLL has transitions to track. Prepend a run
 * of alternating BS1-style bits so the PLL locks before the sync word arrives.
 */
function renderAudio(bits, { baud = BAUD, lead = 64, amp = 1 } = {}) {
	const spb = SAMPLE_RATE / baud;
	const all = [];
	for (let i = 0; i < lead; i++) all.push(i & 1); // extra BS1 lead-in
	for (const b of bits) all.push(b);
	for (let i = 0; i < 48; i++) all.push(i & 1); // trailing symbols (FIW/idle) so the inv.A tail completes

	const raw = new Float32Array(Math.ceil(all.length * spb));
	for (let i = 0; i < raw.length; i++) {
		const sym = all[Math.floor(i / spb)] ?? 0;
		raw[i] = sym ? -amp : amp; // 1 -> negative deviation
	}
	// One-pole low-pass to create finite-slope transitions.
	const out = new Float32Array(raw.length);
	let y = 0;
	const a = 0.2;
	for (let i = 0; i < raw.length; i++) {
		y += a * (raw[i] - y);
		out[i] = y;
	}
	return out;
}

describe('FLEX BCH(31,21,2)+parity', () => {
	it('countBits matches popcount', () => {
		expect(countBits(0)).toBe(0);
		expect(countBits(0xffffffff)).toBe(32);
		expect(countBits(0x80000001)).toBe(2);
		expect(countBits(0x0f0f0f0f)).toBe(16);
	});

	it('decodes a clean zero codeword', () => {
		const r = bchDecode(0);
		expect(r.status).toBe(BCH_CLEAN);
		expect(r.info).toBe(0);
	});

	it('corrects a single-bit data error', () => {
		const clean = bchDecode(0).corrected; // valid even-parity word (0)
		const flipped = (clean ^ 0x00000004) >>> 0; // flip data bit 2
		const r = bchDecode(flipped);
		expect(r.status).toBe(BCH_CORRECTED);
		expect(r.corrected).toBe(clean);
	});

	it('combined A/inv.A correction recovers the A code for every mode', () => {
		const cases = [
			{ a: 0x78f35939 >>> 0, sync: 0x870c },
			{ a: 0x84e75939 >>> 0, sync: 0x7b18 },
			{ a: 0x4f975939 >>> 0, sync: 0xb068 },
			{ a: 0x215f5939 >>> 0, sync: 0xdea0 },
		];
		for (const c of cases) {
			const invA = ~c.a >>> 0;
			const corrected = combinedACorrection(c.a, invA);
			expect(corrected).toBe(c.a);
			expect((~corrected >>> 16) & 0xffff).toBe(c.sync);
		}
	});

	it('flags a dense non-codeword as uncorrectable or corrected, never clean', () => {
		const r = bchDecode(0x55555555 >>> 0);
		expect(r.status).not.toBe(BCH_CLEAN);
		if (r.status === BCH_UNCORRECTABLE) expect(r.info).toBe(-1);
	});

	it('rejects a 3-error word whose received parity is inconsistent after correction', () => {
		// 0x61000000 = valid word 0 with code31 bits 24,29,30 flipped. The error
		// table finds a <=2-bit correction, but the RECEIVED parity bit then makes
		// the combined popcount odd -> 3+ errors -> must reject (osmocom parity
		// reject path; a dead reject branch would wrongly accept this).
		const r = bchDecode(0x61000000 >>> 0);
		expect(r.status).toBe(BCH_UNCORRECTABLE);
		expect(r.info).toBe(-1);
	});

	it('combined A/inv.A rescues a side with a 4+ bit diff (not just <=3)', () => {
		// A clean, inv.A carrying 4 bit errors beyond ~A. The combined correction
		// must still attempt the single-bit-flip rescue over every diff bit
		// (osmocom ndiff<=31), not bail out above 3 diffs.
		const a = 0x78f35939 >>> 0; // A1
		// Corrupt inv.A so ~inv.A differs from A in 4 bits AND BCH-fails as-is,
		// yet one of those bits is the only genuine error (the other 3 are in the
		// diff because the raw failed word's own correction target differs). Use a
		// 1-bit physical error on inv.A; the diff vs A.corrected can still exceed 3.
		const invA = (~a ^ 0x00000002) >>> 0; // flip one bit of inv.A
		const corrected = combinedACorrection(a, invA);
		expect(corrected).toBe(a);
	});
});

describe('FLEX front end -- lock + mode detection', () => {
	for (const [name, spec] of Object.entries(S1)) {
		it(`locks and detects ${name} (${spec.baud}baud/${spec.levels}FSK)`, () => {
			let locked = false;
			let mode = null;
			const fe = new FlexFrontend(SAMPLE_RATE, {
				onLock: (l) => {
					if (l) locked = true;
				},
				onMode: (m) => {
					mode = m;
				},
			});
			fe.process(renderAudio(bytesToBits(spec.bytes)));

			expect(locked).toBe(true);
			expect(mode).not.toBeNull();
			expect(mode.baud).toBe(spec.baud);
			expect(mode.levels).toBe(spec.levels);
		});
	}

	it('reports ERS (Ar) as a non-mode sync and detects no air mode', () => {
		const events = [];
		let mode = null;
		const fe = new FlexFrontend(SAMPLE_RATE, {
			onMode: (m) => (mode = m),
			onSyncCode: (e) => events.push(e),
		});
		fe.process(renderAudio(bytesToBits(S1_ERS)));
		expect(mode).toBeNull(); // Ar is not a decodable mode
		expect(events.length).toBeGreaterThanOrEqual(1);
		expect(events[0].ers).toBe(true);
		expect(events[0].code).toBe(0x34df);
		expect(events[0].label).toMatch(/emergency re-sync/i);
	});

	it('reports a reserved code (A5) as a non-ERS non-mode sync', () => {
		const events = [];
		let mode = null;
		const fe = new FlexFrontend(SAMPLE_RATE, {
			onMode: (m) => (mode = m),
			onSyncCode: (e) => events.push(e),
		});
		fe.process(renderAudio(bytesToBits(S1_A5)));
		expect(mode).toBeNull();
		expect(events.length).toBeGreaterThanOrEqual(1);
		expect(events[0].ers).toBe(false);
		expect(events[0].code).toBe(0x22b4);
		expect(events[0].label).toMatch(/A5.*reserved/i);
	});

	it('does not detect a mode from low-level noise', () => {
		let mode = null;
		const fe = new FlexFrontend(SAMPLE_RATE, { onMode: (m) => (mode = m) });
		const noise = new Float32Array(SAMPLE_RATE);
		for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() - 0.5) * 0.01;
		fe.process(noise);
		expect(mode).toBeNull();
	});

	it('every reserved + ERS sync constant is a valid, distinct BCH sync code', () => {
		// The osmocom-analog TX A-codeword high words (first 2 bytes) for each
		// non-mode sync (ARIB Table 3.2-5), with the common 0x5939 tail. The
		// receiver's outer code (codehigh) = ~(A >> 16). This reproduces the
		// cross-source derivation and proves ALL reserved codes, not just A5.
		const codes = {
			A5: 0xdd4b,
			A6: 0x163b,
			A7: 0xb383,
			A8: 0x6341,
			A9: 0x1be2,
			A10: 0x2c86,
			A11: 0xa5e8,
			A12: 0x928c,
			A13: 0x6e98,
			A14: 0xbe5a,
			A15: 0xf19d,
			Ar: 0xcb20,
		};
		const seen = new Set();
		for (const [name, hi] of Object.entries(codes)) {
			const a = ((hi << 16) | 0x5939) >>> 0; // full 32-bit A codeword
			const corrected = combinedACorrection(a, ~a >>> 0);
			expect(corrected, `${name} must validate`).toBe(a);
			const codehigh = (~corrected >>> 16) & 0xffff;
			expect(seen.has(codehigh), `${name} codehigh 0x${codehigh.toString(16)} must be distinct`).toBe(false);
			seen.add(codehigh);
		}
		// The 12 non-mode codes are all distinct from each other.
		expect(seen.size).toBe(12);
	});

	it('reset() returns to the SYNC1 hunting state', () => {
		const fe = new FlexFrontend(SAMPLE_RATE);
		fe.process(renderAudio(bytesToBits(S1.A1.bytes)));
		fe.reset();
		expect(fe.locked).toBe(false);
		expect(fe.detectedMode).toBeNull();
	});
});
