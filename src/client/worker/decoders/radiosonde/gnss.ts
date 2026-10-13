import type { Radiosonde, SondeSatellite } from './types';

/** Preserve the legacy u-blox per-satellite data from checked GPS blocks. */
export function decodeGnss(blocks: Map<number, Uint8Array>): Partial<Radiosonde> {
	const info = blocks.get(0x7c);
	const raw = blocks.get(0x7d);
	if (info?.length !== 30) return {};
	const satellites: SondeSatellite[] = [];
	for (let index = 0; index < 12; index++) {
		const prn = info[6 + index * 2];
		if (!prn || prn === 255) continue;
		const flags = info[7 + index * 2];
		const sat: SondeSatellite = { prn, signal: flags >>> 5, quality: flags & 31 };
		if (raw?.length === 89) {
			const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
			const offset = 5 + index * 7;
			const delta = view.getUint32(offset, true);
			if (delta !== 0xffffffff) sat.pseudorange = view.getUint32(0, true) + delta / 256;
			const unsigned = raw[offset + 4] | (raw[offset + 5] << 8) | (raw[offset + 6] << 16);
			sat.doppler = unsigned & 0x800000 ? unsigned - 0x1000000 : unsigned;
		}
		satellites.push(sat);
	}
	return {
		gnssSatellites: satellites,
		...(raw?.length === 89 && raw[4] !== 255 ? { gnssJamming: raw[4] >>> 4, gnssAgc: raw[4] & 15 } : {}),
	};
}
