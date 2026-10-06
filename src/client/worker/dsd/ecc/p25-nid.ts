/** Extended BCH(64,16,23) used by the P25 Network Identifier.
 * Generator rows are the TIA-102 test-vector matrix published in OP25
 * p25craft.py (Copyright 2011 Michael Ossmann, GPL-2.0-or-later):
 * https://github.com/boatbod/op25/blob/master/op25/gr-op25_repeater/apps/tx/p25craft.py
 * Normal error-free reception uses the O(1) lookup; damaged words use a
 * bounded-distance search across legal NAC/DUID combinations.
 */
const ROWS = [
	0x8000cd930bdd3b2an, 0x4000ab5a8e33a6ben, 0x2000983e4cc4e874n, 0x10004c1f2662743an,
	0x0800eb9c98ec0136n, 0x0400b85d47ab3bb0n, 0x02005c2ea3d59dd8n, 0x01002e1751eaceecn,
	0x0080170ba8f56776n, 0x0040c616dfa78890n, 0x0020630b6fd3c448n, 0x00103185b7e9e224n,
	0x000818c2dbf4f112n, 0x0004c1f2662743a2n, 0x0002ad6a38ce9afbn, 0x00019b2617ba7657n,
];
const high = new Uint32Array(65536);
const low = new Uint32Array(65536);
const DUIDS = [0, 3, 5, 7, 10, 12, 15];
for (let data = 1; data < high.length; data++) {
	const bit = data & -data;
	const row = 15 - Math.log2(bit);
	high[data] = high[data ^ bit] ^ Number(ROWS[row] >> 32n);
	low[data] = low[data ^ bit] ^ Number(ROWS[row] & 0xffffffffn);
}
function weight(v: number): number {
	v -= (v >>> 1) & 0x55555555;
	v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
	return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
export function decodeP25NID(bits: Uint8Array): { data: number; errors: number } | null {
	if (bits.length !== 64) return null;
	let hi = 0, lo = 0;
	for (let i = 0; i < 32; i++) { hi = (hi << 1) | bits[i]; lo = (lo << 1) | bits[i + 32]; }
	const raw = hi >>> 16;
	const distance = (data: number) => weight(hi ^ high[data]) + weight(lo ^ low[data]);
	// A candidate within eleven bits is unique because minimum distance is 23.
	if (DUIDS.includes(raw & 15)) {
		const errors = distance(raw);
		if (errors <= 11) return { data: raw, errors };
	}
	for (let nac = 0; nac < 4096; nac++) for (const duid of DUIDS) {
		const data = (nac << 4) | duid;
		if (weight(hi ^ high[data]) > 11) continue;
		const errors = distance(data);
		if (errors <= 11) return { data, errors };
	}
	return null;
}
