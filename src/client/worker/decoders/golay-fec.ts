/**
 * GSC forward-error-correction primitives: Golay(23,12) and BCH(15,7) decode,
 * the BCH systematic re-encode used for the data checksum, and the two
 * bitstream readers (duplicate-Golay and interleaved-BCH). Extracted from
 * golay.ts so the decoder state machine stays under the file-size limit. The
 * generator polynomials and syndrome logic are a faithful port of
 * osmocom-analog src/golay/golay.c.
 */

const GEN_GOL = 0x00000c75;
const GOL_X22 = 0x00400000;
const GOL_X11 = 0x00000800;
const GOL_MASK12 = 0xfffff800 >>> 0;

const GEN_BCH = 0x00000117;
const BCH_X14 = 0x4000;
const BCH_X8 = 0x0100;
const BCH_MASK7 = 0xff00;

function golaySyndromeCalc(codeword: number): number {
	let syndrome = codeword >>> 0;
	let aux = GOL_X22;
	if (syndrome >= GOL_X11) {
		while ((syndrome & GOL_MASK12) >>> 0) {
			while (!(aux & syndrome)) aux = aux >>> 1;
			syndrome = (syndrome ^ (Math.floor(aux / GOL_X11) * GEN_GOL)) >>> 0;
		}
	}
	return syndrome >>> 0;
}

function bchSyndromeCalc(codeword: number): number {
	let syndrome = codeword & 0xffff;
	let aux = BCH_X14;
	if (syndrome >= BCH_X8) {
		while (syndrome & BCH_MASK7) {
			while (!(aux & syndrome)) aux = aux >>> 1;
			syndrome = (syndrome ^ (Math.floor(aux / BCH_X8) * GEN_BCH)) & 0xffff;
		}
	}
	return syndrome & 0xff;
}

// Syndrome -> error-pattern lookup tables (built once).
const golaySyndrome = new Uint32Array(2048).fill(0xffffffff);
const bchSyndrome = new Uint16Array(256).fill(0xffff);
let _fecInit = false;

export function initFec(): void {
	if (_fecInit) return;
	golaySyndrome[0] = 0;
	for (let i = 0; i < 23; i++) {
		const e = (1 << i) >>> 0;
		golaySyndrome[golaySyndromeCalc(e)] = e;
	}
	for (let i = 0; i < 23; i++)
		for (let j = i + 1; j < 23; j++) {
			const e = ((1 << i) | (1 << j)) >>> 0;
			golaySyndrome[golaySyndromeCalc(e)] = e;
		}
	for (let i = 0; i < 23; i++)
		for (let j = i + 1; j < 23; j++)
			for (let k = j + 1; k < 23; k++) {
				const e = ((1 << i) | (1 << j) | (1 << k)) >>> 0;
				golaySyndrome[golaySyndromeCalc(e)] = e;
			}
	bchSyndrome[0] = 0;
	for (let i = 0; i < 15; i++) {
		const e = (1 << i) & 0xffff;
		bchSyndrome[bchSyndromeCalc(e)] = e;
	}
	for (let i = 0; i < 15; i++)
		for (let j = i + 1; j < 15; j++) {
			const e = ((1 << i) | (1 << j)) & 0xffff;
			bchSyndrome[bchSyndromeCalc(e)] = e;
		}
	_fecInit = true;
}

/** Decode a 23-bit Golay codeword. Returns {data, errors} or null (uncorrectable).
 * errors is the Hamming weight of the applied correction (0..3). */
export function decodeGolay(codeword: number): { data: number; errors: number } | null {
	const syndrome = golaySyndromeCalc(codeword >>> 0);
	if (syndrome === 0) return { data: codeword & 0xfff, errors: 0 };
	const err = golaySyndrome[syndrome];
	if (err === 0xffffffff) return null;
	const corrected = (codeword ^ err) >>> 0;
	return { data: corrected & 0xfff, errors: popcount(err) };
}

/** Decode a 15-bit BCH codeword. Returns {data, errors} or null (uncorrectable). */
export function decodeBch(codeword: number): { data: number; errors: number } | null {
	const syndrome = bchSyndromeCalc(codeword & 0xffff);
	if (syndrome === 0) return { data: codeword & 0x7f, errors: 0 };
	const err = bchSyndrome[syndrome];
	if (err === 0xffff) return null;
	const corrected = (codeword ^ err) & 0xffff;
	return { data: corrected & 0x7f, errors: popcount(err) };
}

/** BCH systematic re-encode of 7 data bits -> 15-bit codeword (for checksum). */
export function calcBch(data: number): number {
	let syndrome = (data & 0x7f) << 8;
	let aux = BCH_X14;
	if (syndrome >= BCH_X8) {
		while (syndrome & BCH_MASK7) {
			while (!(aux & syndrome)) aux = aux >>> 1;
			syndrome = (syndrome ^ (Math.floor(aux / BCH_X8) * GEN_BCH)) & 0xffff;
		}
	}
	return ((data & 0x7f) | (syndrome << 7)) & 0xffff;
}

function popcount(x: number): number {
	let v = x >>> 0;
	v -= (v >>> 1) & 0x55555555;
	v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
	v = (v + (v >>> 4)) & 0x0f0f0f0f;
	return Math.imul(v, 0x01010101) >>> 24;
}

// ── Bitstream readers (operate on a 0/1 array) ─────────────────────────────

/** Read a duplicate-transmitted 23-bit Golay codeword (46 bits, LSB-first).
 * Each codeword bit is sent twice; on disagreement prefer the first. */
export function readDupGolay(bits: number[], pos: number): { cw: number; pos: number } {
	let cw = 0;
	let p = pos;
	for (let i = 0; i < 23; i++) {
		const b1 = bits[p];
		cw |= (b1 & 1) << i;
		p += 2;
	}
	return { cw: cw >>> 0, pos: p };
}

/** De-interleave 8 BCH(15,7) codewords (120 bits), inverse of the encoder's
 * j,k interleave loop. Advances past 120 bits. */
export function deinterleaveBch(bits: number[], pos: number): { bch: number[]; pos: number } {
	const bch = new Array<number>(8).fill(0);
	let p = pos;
	for (let j = 0; j < 15; j++) {
		for (let k = 0; k < 8; k++) {
			bch[k] |= (bits[p] & 1) << j;
			p++;
		}
	}
	return { bch, pos: p };
}
