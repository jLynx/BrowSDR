import type { AircraftState, CprFrame } from './types';
import { airbornePosition } from './cpr';

export function bits(bytes: Uint8Array, start: number, length: number): number {
	let value = 0;
	for (let i = start; i < start + length; i++) value = value * 2 + ((bytes[i >> 3] >> (7 - (i & 7))) & 1);
	return value;
}

/** Mode S polynomial, including the received parity: valid DF17 has zero remainder. */
export function validAdsbFrame(bytes: Uint8Array): boolean {
	if (bytes.length !== 14 || bytes[0] >> 3 !== 17) return false;
	let crc = 0;
	for (const byte of bytes) {
		for (let bit = 7; bit >= 0; bit--) {
			const top = crc & 0x800000;
			crc = ((crc << 1) | ((byte >> bit) & 1)) & 0xffffff;
			if (top) crc ^= 0xfff409;
		}
	}
	return crc === 0;
}

export function updateAircraft(bytes: Uint8Array, aircraft: AircraftState, time: number): void {
	aircraft.lastSeen = time;
	aircraft.messages++;
	const type = bits(bytes, 32, 5);
	if (type >= 1 && type <= 4) {
		const category = bits(bytes, 37, 3);
		if (category) aircraft.category = (4 - type) * 8 + category;
		else delete aircraft.category;
		let callsign = '';
		for (let i = 0; i < 8; i++) {
			const code = bits(bytes, 40 + i * 6, 6);
			callsign += code >= 1 && code <= 26 ? String.fromCharCode(64 + code) : code >= 48 && code <= 57 ? String.fromCharCode(code) : ' ';
		}
		aircraft.callsign = callsign.trim();
	} else if ((type >= 9 && type <= 18) || (type >= 20 && type <= 22)) {
		updatePosition(bytes, aircraft, time, type >= 20);
	} else if (type === 19) {
		updateVelocity(bytes, aircraft);
	} else if (type === 28 && bits(bytes, 37, 3) === 1) {
		aircraft.squawk = decodeSquawk(bits(bytes, 43, 13));
	}
}

/** Mode A identity bits C1 A1 C2 A2 C4 A4 X B1 D1 B2 D2 B4 D4. */
function decodeSquawk(code: number): string {
	const a = ((code >> 11) & 1) | (((code >> 9) & 1) << 1) | (((code >> 7) & 1) << 2);
	const b = ((code >> 5) & 1) | (((code >> 3) & 1) << 1) | (((code >> 1) & 1) << 2);
	const c = ((code >> 12) & 1) | (((code >> 10) & 1) << 1) | (((code >> 8) & 1) << 2);
	const d = ((code >> 4) & 1) | (((code >> 2) & 1) << 1) | ((code & 1) << 2);
	return `${a}${b}${c}${d}`;
}

function updatePosition(bytes: Uint8Array, aircraft: AircraftState, time: number, gnss: boolean): void {
	const altitude = bits(bytes, 40, 12);
	// GNSS height uses metres; barometric Q=1 uses 25-foot increments.
	if (altitude && (gnss || altitude & 16)) {
		aircraft.altitude = gnss ? Math.round(altitude / 0.3048) : (((altitude & 0xfe0) >> 1) | (altitude & 15)) * 25 - 1000;
		aircraft.altitudeSource = gnss ? 'GNSS' : 'barometric';
	} else {
		delete aircraft.altitude;
		delete aircraft.altitudeSource;
	}
	const frame: CprFrame = {
		latitude: bits(bytes, 54, 17),
		longitude: bits(bytes, 71, 17),
		odd: !!bits(bytes, 53, 1),
		time,
		gnss,
	};
	if (frame.odd) aircraft.odd = frame;
	else aircraft.even = frame;
	if (!aircraft.even || !aircraft.odd) return;
	const position = airbornePosition(aircraft.even, aircraft.odd);
	if (position) Object.assign(aircraft, position, { positionTime: time });
}

function updateVelocity(bytes: Uint8Array, aircraft: AircraftState): void {
	const subtype = bits(bytes, 37, 3);
	if (subtype === 1 || subtype === 2) {
		const east = bits(bytes, 46, 10);
		const north = bits(bytes, 57, 10);
		if (east && north) {
			const scale = subtype === 2 ? 4 : 1;
			const vx = (east - 1) * scale * (bits(bytes, 45, 1) ? -1 : 1);
			const vy = (north - 1) * scale * (bits(bytes, 56, 1) ? -1 : 1);
			aircraft.speed = Math.round(Math.hypot(vx, vy));
			aircraft.heading = ((Math.atan2(vx, vy) * 180) / Math.PI + 360) % 360;
		} else {
			delete aircraft.speed;
			delete aircraft.heading;
		}
	}
	const rate = bits(bytes, 69, 9);
	if (rate) aircraft.verticalRate = (rate - 1) * 64 * (bits(bytes, 68, 1) ? -1 : 1);
	else delete aircraft.verticalRate;
}
