import type { Radiosonde, Rs41Packet, SondeBlock } from './types';
import { decodeGnss } from './gnss';

// RS41 wire format: 4800 baud, LSB first, repeating 64-byte whitening mask.
// Protocol reference: https://github.com/rs1729/RS/tree/master/demod/mod
export const RS41_SYNC = new Uint8Array([0x10, 0xb6, 0xca, 0x11, 0x22, 0x96, 0x12, 0xf8]);
export const RS41_MASK = new Uint8Array([
	0x96, 0x83, 0x3e, 0x51, 0xb1, 0x49, 0x08, 0x98, 0x32, 0x05, 0x59, 0x0e, 0xf9, 0x44, 0xc6, 0x26, 0x21, 0x60, 0xc2, 0xea, 0x79, 0x5d, 0x6d,
	0xa1, 0x54, 0x69, 0x47, 0x0c, 0xdc, 0xe8, 0x5c, 0xf1, 0xf7, 0x76, 0x82, 0x7f, 0x07, 0x99, 0xa2, 0x2c, 0x93, 0x7c, 0x30, 0x63, 0xf5, 0x10,
	0x2e, 0x61, 0xd0, 0xbc, 0xb4, 0xb6, 0x06, 0xaa, 0xf4, 0x23, 0x78, 0x6e, 0x3b, 0xae, 0xbf, 0x7b, 0x4c, 0xc1,
]);

export function rs41Crc(bytes: Uint8Array): number {
	let crc = 0xffff;
	for (const byte of bytes) {
		crc ^= byte << 8;
		for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
	}
	return crc;
}

/** Interpret only independently CRC-checked blocks; never guess a GPS fix. */
export function decodeRs41(frame: Uint8Array): Partial<Radiosonde> | null {
	return decodeRs41Packet(frame)?.telemetry ?? null;
}

export function decodeRs41Packet(frame: Uint8Array): Rs41Packet | null {
	if (frame.length !== 320 && frame.length !== 518) return null;
	const blocks = new Map<number, Uint8Array>();
	const rawBlocks: SondeBlock[] = [];
	for (let offset = 57; offset + 4 <= frame.length;) {
		const type = frame[offset];
		const length = frame[offset + 1];
		const end = offset + 2 + length;
		if (end + 2 > frame.length) break;
		const data = frame.subarray(offset + 2, end);
		const crcValid = rs41Crc(data) === (frame[end] | (frame[end + 1] << 8));
		if (crcValid) blocks.set(type, data);
		rawBlocks.push({ type, data: Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join(''), crcValid });
		offset = end + 2;
	}
	const identity = blocks.get(0x79);
	if (!identity || identity.length !== 40) return null;
	const id = String.fromCharCode(...identity.subarray(2, 10));
	if (!/^[A-Z0-9]{8}$/.test(id)) return null;
	const statusFlags = identity[13] | (identity[14] << 8);
	const result: Partial<Radiosonde> = {
		id,
		model: 'RS41',
		frame: identity[0] | (identity[1] << 8),
		battery: identity[10] / 10,
		txPower: identity[21],
		referenceTemperature: identity[16] > 127 ? identity[16] - 256 : identity[16],
		flightPhase: !(statusFlags & 1) ? 'startup' : statusFlags & 2 ? 'descent' : 'ascent',
		statusFlags,
		errorFlags: identity[17] | (identity[18] << 8),
		cryptoMode: identity[15],
		humidityHeating: (identity[19] | (identity[20] << 8)) / 10,
		rawBlocks,
	};
	const gps = blocks.get(0x7b);
	if (gps?.length === 21) {
		Object.assign(result, decodeEcef(gps));
		result.speedAccuracy = gps[19] / 10;
		result.positionDop = gps[20] / 10;
	}
	// New RS41 GNSS firmware combines ECEF position/velocity and UTC date.
	const gnss = blocks.get(0x82);
	if (gnss?.length === 38) {
		Object.assign(result, decodeEcef(gnss, false));
		result.gpsTime = gnssUtc(gnss);
	}
	const time = blocks.get(0x7c);
	if (time?.length === 30) Object.assign(result, legacyGpsTime(time));
	Object.assign(result, decodeGnss(blocks));
	const auxiliary = decodeAuxiliary(rawBlocks);
	if (auxiliary.length) result.auxiliary = auxiliary;
	return { telemetry: result, identity, blocks };
}

function legacyGpsTime(time: Uint8Array): Partial<Radiosonde> {
	const view = new DataView(time.buffer, time.byteOffset, time.byteLength);
	const week = view.getUint16(0, true);
	const tow = view.getUint32(2, true);
	return week > 1600 && tow < 604800000 ? { gpsTime: gpsUtc(week, tow) } : {};
}

function decodeAuxiliary(rawBlocks: SondeBlock[]): string[] {
	return rawBlocks
		.filter((block) => block.type === 0x7e && block.crcValid)
		.map((block) => {
			const bytes = block.data.match(/../g)?.map((byte) => parseInt(byte, 16)) ?? [];
			return bytes.every((byte) => byte >= 0x20 && byte < 0x7f) ? String.fromCharCode(...bytes) : block.data;
		});
}

function gpsUtc(week: number, tow: number): number {
	const gps = Date.UTC(1980, 0, 6) + week * 604800000 + tow;
	// Leap offsets covering RS41's lifetime, including pre-2017 recordings.
	const leaps = [
		[Date.UTC(2017, 0, 1), 18],
		[Date.UTC(2015, 6, 1), 17],
		[Date.UTC(2012, 6, 1), 16],
		[Date.UTC(2009, 0, 1), 15],
	];
	const offset = leaps.find(([utc, seconds]) => gps >= utc + seconds * 1000)?.[1] ?? 14;
	return gps - offset * 1000;
}

function gnssUtc(data: Uint8Array): number | undefined {
	const year = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(18, true);
	const [month, day, hour, minute, second, centisecond] = data.subarray(20, 26);
	if (
		year < 2020 ||
		year > 2100 ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > 31 ||
		hour >= 24 ||
		minute >= 60 ||
		second >= 60 ||
		centisecond >= 100
	)
		return undefined;
	return Date.UTC(year, month - 1, day, hour, minute, second, centisecond * 10);
}

function decodeEcef(data: Uint8Array, hasSatellites = true): Partial<Radiosonde> {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const x = view.getInt32(0, true) / 100;
	const y = view.getInt32(4, true) / 100;
	const z = view.getInt32(8, true) / 100;
	const satellites = hasSatellites ? data[18] : undefined;
	const p = Math.hypot(x, y);
	if (Math.hypot(p, z) < 6000000 || (satellites !== undefined && (satellites < 4 || satellites > 32))) return {};
	const a = 6378137;
	const e2 = 6.69437999014e-3;
	const lon = Math.atan2(y, x);
	let lat = Math.atan2(z, p * (1 - e2));
	let altitude = 0;
	for (let iteration = 0; iteration < 8; iteration++) {
		const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
		altitude = Math.abs(Math.cos(lat)) > 1e-8 ? p / Math.cos(lat) - n : Math.abs(z) - n * (1 - e2);
		lat = Math.atan2(z, p * (1 - (e2 * n) / (n + altitude)));
	}
	if (!Number.isFinite(altitude) || altitude < -500 || altitude > 60000) return {};
	const vx = view.getInt16(12, true) / 100;
	const vy = view.getInt16(14, true) / 100;
	const vz = view.getInt16(16, true) / 100;
	const east = -Math.sin(lon) * vx + Math.cos(lon) * vy;
	const north = -Math.sin(lat) * Math.cos(lon) * vx - Math.sin(lat) * Math.sin(lon) * vy + Math.cos(lat) * vz;
	const climb = Math.cos(lat) * Math.cos(lon) * vx + Math.cos(lat) * Math.sin(lon) * vy + Math.sin(lat) * vz;
	return {
		latitude: (lat * 180) / Math.PI,
		longitude: (lon * 180) / Math.PI,
		altitude,
		speed: Math.hypot(east, north),
		course: ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360,
		climb,
		satellites,
	};
}
