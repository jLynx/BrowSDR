import type { RtcmReference, RtcmObservation, RtcmEquipment, RtcmSignalObservation } from './types';
import { signalBand } from './signals';

class Bits {
	position = 0;
	constructor(private data: Uint8Array) {}
	read(width: number): number {
		if (this.position + width > this.data.length * 8) throw new Error('Truncated RTCM field');
		let value = 0;
		for (let i = 0; i < width; i++, this.position++) value = value * 2 + ((this.data[this.position >> 3] >> (7 - (this.position & 7))) & 1);
		return value;
	}
	signed(width: number): number {
		const value = this.read(width);
		return value >= 2 ** (width - 1) ? value - 2 ** width : value;
	}
	skip(width: number): void {
		if (this.position + width > this.data.length * 8) throw new Error('Truncated RTCM field');
		this.position += width;
	}
	text(): string {
		return Array.from({ length: this.read(8) }, () => String.fromCharCode(this.read(8))).join('');
	}
	mask(width: number): number[] {
		return Array.from({ length: width }, (_, index) => (this.read(1) ? index + 1 : 0)).filter(Boolean);
	}
}

/** Convert metre ECEF coordinates onto the WGS84 ellipsoid (no datum/epoch transformation). */
export function ecefToGeodetic(x: number, y: number, z: number): Pick<RtcmReference, 'latitude' | 'longitude' | 'heightM'> | undefined {
	const a = 6378137,
		e2 = 6.6943799901413165e-3;
	const p = Math.hypot(x, y);
	if (Math.hypot(p, z) < 1) return;
	if (p < 1e-6) return { latitude: Math.sign(z) * 90, longitude: 0, heightM: Math.abs(z) - a * Math.sqrt(1 - e2) };
	let latitude = Math.atan2(z, p * (1 - e2));
	for (let i = 0; i < 10; i++) {
		const sin = Math.sin(latitude),
			n = a / Math.sqrt(1 - e2 * sin * sin);
		latitude = Math.atan2(z + e2 * n * sin, p);
	}
	const sin = Math.sin(latitude),
		n = a / Math.sqrt(1 - e2 * sin * sin);
	const heightM = Math.abs(Math.cos(latitude)) > 0.1 ? p / Math.cos(latitude) - n : z / sin - n * (1 - e2);
	return { latitude: (latitude * 180) / Math.PI, longitude: (Math.atan2(y, x) * 180) / Math.PI, heightM };
}

function reference(bits: Bits, type: number, stationId: number): RtcmReference | undefined {
	const itrf = bits.read(6);
	bits.skip(4);
	const x = bits.signed(38) * 0.0001;
	bits.skip(2);
	const y = bits.signed(38) * 0.0001;
	bits.skip(2);
	const z = bits.signed(38) * 0.0001;
	const antennaHeightM = type === 1006 ? bits.read(16) * 0.0001 : undefined;
	const position = ecefToGeodetic(x, y, z);
	return position ? { stationId, itrf, ...position, antennaHeightM, ecef: [x, y, z] } : undefined;
}

const constellations: Record<number, string> = {
	107: 'GPS',
	108: 'GLONASS',
	109: 'Galileo',
	110: 'SBAS',
	111: 'QZSS',
	112: 'BeiDou',
	113: 'NavIC',
};
function observation(bits: Bits, type: number, stationId: number): RtcmObservation | undefined {
	const family = Math.floor(type / 10),
		variant = type % 10;
	if (!constellations[family] || variant < 4 || variant > 7) return;
	const day = family === 108 ? bits.read(3) : undefined;
	const epochMs = bits.read(family === 108 ? 27 : 30),
		multipleMessage = !!bits.read(1);
	bits.skip(18);
	const satellites = bits.mask(64),
		signals = bits.mask(32);
	const measurements: RtcmSignalObservation[] = [];
	for (const satellite of satellites)
		for (const signal of signals)
			if (bits.read(1)) measurements.push({ satellite, signal, cnrDbHz: 0, ...signalBand(constellations[family], signal) });
	const cells = measurements.length;
	const extended = variant === 5 || variant === 7,
		high = variant >= 6;
	bits.skip(satellites.length * (extended ? 36 : 18));
	bits.skip(cells * ((high ? 20 + 24 + 10 : 15 + 22 + 4) + 1));
	const cnrDbHz = Array.from({ length: cells }, () => bits.read(high ? 10 : 6) * (high ? 0.0625 : 1));
	measurements.forEach((measurement, index) => (measurement.cnrDbHz = cnrDbHz[index]));
	if (extended) bits.skip(cells * 15);
	return {
		type,
		stationId,
		constellation: constellations[family],
		epochMs,
		day,
		multipleMessage,
		satellites,
		signals,
		cells,
		cnrDbHz,
		measurements,
		receivedAt: Date.now(),
	};
}

export function decodeRtcmFields(payload: Uint8Array): {
	reference?: RtcmReference;
	observation?: RtcmObservation;
	equipment?: RtcmEquipment;
} {
	try {
		const bits = new Bits(payload),
			type = bits.read(12),
			stationId = bits.read(12);
		if (type === 1005 || type === 1006) return { reference: reference(bits, type, stationId) };
		if (type === 1033) {
			const antenna = bits.text(),
				setupId = bits.read(8),
				antennaSerial = bits.text();
			return {
				equipment: {
					stationId,
					antenna,
					setupId,
					antennaSerial,
					receiver: bits.text(),
					firmware: bits.text(),
					receiverSerial: bits.text(),
				},
			};
		}
		return { observation: observation(bits, type, stationId) };
	} catch {
		return {};
	}
}
