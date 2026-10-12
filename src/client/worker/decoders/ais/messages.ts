import type { Vessel, VesselReport } from './types';

class Bits {
	constructor(private bytes: Uint8Array) {}
	unsigned(start: number, width: number): number {
		let value = 0;
		for (let bit = start; bit < start + width; bit++) value = value * 2 + ((this.bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
		return value;
	}
	signed(start: number, width: number): number {
		const value = this.unsigned(start, width);
		return value >= 2 ** (width - 1) ? value - 2 ** width : value;
	}
	text(start: number, width: number): string {
		let result = '';
		for (let bit = start; bit < start + width; bit += 6) {
			const value = this.unsigned(bit, 6);
			result += String.fromCharCode(value < 32 ? value + 64 : value);
		}
		return result.replace(/[@\s]+$/, '').trim();
	}
}

function position(bits: Bits, longitude: number, latitude: number, width = 28, scale = 600000): Partial<Vessel> {
	const lon = bits.signed(longitude, width) / scale;
	const lat = bits.signed(latitude, width - 1) / scale;
	return { longitude: Math.abs(lon) <= 180 ? lon : undefined, latitude: Math.abs(lat) <= 90 ? lat : undefined };
}

function movement(bits: Bits, speed: number, course: number, heading: number): Partial<Vessel> {
	const sog = bits.unsigned(speed, 10);
	const cog = bits.unsigned(course, 12);
	const hdg = bits.unsigned(heading, 9);
	return { speed: sog < 1023 ? sog / 10 : undefined, course: cog < 3600 ? cog / 10 : undefined, heading: hdg < 360 ? hdg : undefined };
}

/** Only supported, length-checked vessel reports enter the tracker. Radio CRC is checked before this boundary. */
export function decodeAis(frame: Uint8Array): VesselReport | undefined {
	if (frame.length < 5) return;
	const bits = new Bits(frame);
	const type = bits.unsigned(0, 6);
	const mmsi = bits.unsigned(8, 30).toString().padStart(9, '0');
	if (mmsi === '000000000' || Number(mmsi) > 999999999) return;
	const report = { mmsi };
	if ([1, 2, 3].includes(type) && frame.length === 21)
		return { ...report, navigationStatus: bits.unsigned(38, 4), ...movement(bits, 50, 116, 128), ...position(bits, 61, 89) };
	if ([18, 19].includes(type) && frame.length === (type === 18 ? 21 : 39)) {
		const dynamic = { ...report, ...movement(bits, 46, 112, 124), ...position(bits, 57, 85) };
		return type === 18 ? dynamic : { ...dynamic, name: bits.text(143, 120), shipType: bits.unsigned(263, 8) };
	}
	if (type === 5 && frame.length === 53)
		return {
			...report,
			imo: bits.unsigned(40, 30) || undefined,
			callsign: bits.text(70, 42),
			name: bits.text(112, 120),
			shipType: bits.unsigned(232, 8),
			draught: bits.unsigned(294, 8) / 10 || undefined,
			destination: bits.text(302, 120),
		};
	if (type === 24) return staticClassB(bits, report, frame.length);
	if (type === 27 && frame.length === 12) {
		const speed = bits.unsigned(79, 6);
		const course = bits.unsigned(85, 9);
		return {
			...report,
			navigationStatus: bits.unsigned(40, 4),
			...position(bits, 44, 62, 18, 600),
			speed: speed < 63 ? speed : undefined,
			course: course < 360 ? course : undefined,
		};
	}
}

function staticClassB(bits: Bits, report: VesselReport, size: number): VesselReport | undefined {
	const part = bits.unsigned(38, 2);
	if (part === 0 && (size === 20 || size === 21)) return { ...report, name: bits.text(40, 120) };
	if (part === 1 && size === 21) return { ...report, shipType: bits.unsigned(40, 8), callsign: bits.text(90, 42) };
}
