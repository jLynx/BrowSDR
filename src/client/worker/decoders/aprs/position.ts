import { base91, readable } from './ax25';
import { decodeWeather, windExtension } from './weather';
import type { AprsReport, AprsWeather } from './types';

export const KNOT = 1.852;
export const FOOT = 0.3048;
const MILE = 1.609344;
// Half of the area hidden by each ambiguity level, in minutes: positions are placed at its center.
const AMBIGUITY_CENTER = [0, 0.05, 0.5, 5, 30];

export const validTable = (char: string | undefined) => !!char && /^[/\\A-Z0-9]$/.test(char);
export const validCode = (char: string | undefined) => !!char && char >= '!' && char <= '~';

/** Degrees from DD(D) plus four minute digits; trailing spaces from position ambiguity become zeros. */
export function angle(degrees: string, digits: string, ambiguity: number, negative: boolean, limit: number): number | undefined {
	const masked = digits.slice(0, 4 - ambiguity).padEnd(4, '0');
	if (!/^\d+$/.test(degrees) || !/^\d{4}$/.test(masked) || Number(masked.slice(0, 2)) >= 60) return;
	const value = Number(degrees) + (Number(masked.slice(0, 2)) + Number(masked.slice(2)) / 100 + AMBIGUITY_CENTER[ambiguity]) / 60;
	if (value > limit) return;
	return negative ? -value : value;
}

export function ambiguityOf(digits: string): number | undefined {
	if (!/^\d* *$/.test(digits)) return;
	return digits.length - digits.trimEnd().length;
}

/** `/A=` altitude in feet anywhere in the comment, with the comment that remains. */
export function altitudeComment(text: string): { altitude?: number; comment?: string } {
	const match = /\/A=(-\d{5}|\d{6})/.exec(text);
	const comment = readable(match ? text.slice(0, match.index) + text.slice(match.index + match[0].length) : text);
	return { ...(match ? { altitude: Number(match[1]) * FOOT } : {}), ...(comment ? { comment } : {}) };
}

/** Uncompressed (`DDMM.hhN/DDDMM.hhW$`) or compressed (`/YYYYXXXX$csT`) position, followed by extensions and comment. */
export function decodePosition(text: string): Partial<AprsReport> | undefined {
	const first = text.charCodeAt(0);
	return (first >= 48 && first <= 57) || first === 32 ? uncompressed(text) : compressed(text);
}

function uncompressed(text: string): Partial<AprsReport> | undefined {
	const lat = /^(\d{2})([0-9 ]{2})\.([0-9 ]{2})([NnSs])$/.exec(text.slice(0, 8));
	const lon = /^(\d{3})([0-9 ]{2})\.([0-9 ]{2})([EeWw])$/.exec(text.slice(9, 18));
	if (!lat || !lon || !validTable(text[8]) || !validCode(text[18])) return;
	const ambiguity = ambiguityOf(lat[2] + lat[3]);
	if (ambiguity === undefined) return;
	// Longitude shares the latitude's ambiguity, whatever digits are sent.
	const longitudeDigits = (lon[2] + lon[3]).replace(/ /g, '0');
	const latitude = angle(lat[1], lat[2] + lat[3], ambiguity, /s/i.test(lat[4]), 90);
	const longitude = angle(lon[1], longitudeDigits, ambiguity, /w/i.test(lon[4]), 180);
	if (latitude === undefined || longitude === undefined) return;
	return {
		format: 'uncompressed',
		latitude,
		longitude,
		...(ambiguity ? { ambiguity } : {}),
		symbol: text[8] + text[18],
		...extensions(text.slice(19), text[18] === '_'),
	};
}

function extensions(rest: string, weatherStation: boolean): Partial<AprsReport> {
	const report: Partial<AprsReport> = {};
	const motion = /^([0-9. ]{3})\/([0-9. ]{3})/.exec(rest);
	if (motion) {
		rest = rest.slice(7);
		if (weatherStation) report.weather = windExtension(motion[1], motion[2]);
		else Object.assign(report, motionExtension(motion[1], motion[2]));
	} else {
		const extension = stationExtension(rest);
		if (extension) {
			rest = rest.slice(7);
			Object.assign(report, extension);
		}
	}
	if (weatherStation) {
		const decoded = decodeWeather(rest, report.weather);
		rest = decoded.rest;
		report.weather = decoded.weather;
	}
	return { ...report, ...altitudeComment(rest) };
}

function motionExtension(course: string, speed: string): Partial<AprsReport> {
	const report: Partial<AprsReport> = {};
	// Course 000 means unknown; 360 is north.
	if (/^\d{3}$/.test(course) && Number(course) >= 1 && Number(course) <= 360) report.course = Number(course);
	if (/^\d{3}$/.test(speed)) report.speed = Number(speed) * KNOT;
	return report;
}

function stationExtension(rest: string): Partial<AprsReport> | undefined {
	const phg = /^PHG(\d)([0-~])(\d)(\d)/.exec(rest);
	if (phg)
		return {
			phg: {
				power: Number(phg[1]) ** 2,
				height: 10 * 2 ** (phg[2].charCodeAt(0) - 48) * FOOT,
				gain: Number(phg[3]),
				directivity: Number(phg[4]) * 45,
			},
		};
	const range = /^RNG(\d{4})/.exec(rest);
	if (range) return { range: Number(range[1]) * MILE };
}

function compressed(text: string): Partial<AprsReport> | undefined {
	if (text.length < 13 || !/^[/\\A-Za-j]$/.test(text[0]) || !validCode(text[9])) return;
	const y = base91(text.slice(1, 5));
	const x = base91(text.slice(5, 9));
	if (y === undefined || x === undefined) return;
	const latitude = 90 - y / 380926;
	const longitude = -180 + x / 190463;
	if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return;
	// Overlay digits use a–j because a digit would look like an uncompressed latitude.
	const table = text[0] >= 'a' ? String.fromCharCode(text.charCodeAt(0) - 49) : text[0];
	const report: Partial<AprsReport> = { format: 'compressed', latitude, longitude, symbol: table + text[9], ...compressedExtension(text) };
	let rest = text.slice(13);
	if (text[9] === '_') {
		// A weather station's course and speed bytes carry wind direction and speed.
		const wind: AprsWeather = {};
		if (report.course !== undefined) wind.windDirection = report.course;
		if (report.speed !== undefined) wind.windSpeed = report.speed / 3.6;
		delete report.course;
		delete report.speed;
		const decoded = decodeWeather(rest, wind);
		report.weather = decoded.weather;
		rest = decoded.rest;
	}
	return { ...report, ...altitudeComment(rest) };
}

function compressedExtension(text: string): Partial<AprsReport> {
	const c = text.charCodeAt(10) - 33;
	const s = text.charCodeAt(11) - 33;
	const type = text.charCodeAt(12) - 33;
	if (text[10] === ' ' || c < 0 || c > 90 || s < 0 || s > 90 || type < 0 || type > 90) return {};
	// Compression type bits 3–4 = 2: the fix came from a GGA sentence and cs holds altitude.
	if (((type >> 3) & 3) === 2) return { altitude: 1.002 ** (c * 91 + s) * FOOT };
	if (text[10] === '{') return { range: 2 * 1.08 ** s * MILE };
	if (c <= 89) return { course: c * 4 || 360, speed: (1.08 ** s - 1) * KNOT };
	return {};
}

/** RMC, GGA and GLL sentences from GPS trackers that transmit raw NMEA. A present checksum must match. */
export function decodeNmea(text: string): Partial<AprsReport> | undefined {
	const match = /^\$(?:GP|GN|GL|GA|BD)(RMC|GGA|GLL),([^*\r\n]*)(?:\*([0-9A-Fa-f]{2}))?/.exec(text);
	if (!match) return;
	if (match[3] !== undefined) {
		let sum = 0;
		for (const char of text.slice(1, text.indexOf('*'))) sum ^= char.charCodeAt(0);
		if (sum !== parseInt(match[3], 16)) return;
	}
	const fields = match[2].split(',');
	const at = { RMC: 2, GGA: 1, GLL: 0 }[match[1] as 'RMC' | 'GGA' | 'GLL'];
	if ((match[1] === 'RMC' && fields[1] !== 'A') || (match[1] === 'GGA' && !(Number(fields[5]) > 0))) return;
	if (match[1] === 'GLL' && fields[5] !== undefined && fields[5] !== 'A') return;
	const latitude = nmeaAngle(fields[at], fields[at + 1], 'S', 2, 90);
	const longitude = nmeaAngle(fields[at + 2], fields[at + 3], 'W', 3, 180);
	if (latitude === undefined || longitude === undefined) return;
	const report: Partial<AprsReport> = { format: 'nmea', latitude, longitude };
	if (match[1] === 'RMC') Object.assign(report, nmeaMotion(fields[6], fields[7]));
	if (match[1] === 'GGA' && /^-?\d+(\.\d+)?$/.test(fields[8] ?? '') && fields[9] === 'M') report.altitude = Number(fields[8]);
	return report;
}

function nmeaAngle(value = '', hemisphere = '', negative: string, digits: number, limit: number): number | undefined {
	const match = new RegExp(`^(\\d{${digits}})(\\d{2}(?:\\.\\d+)?)$`).exec(value);
	if (!match || !/^[NSEW]$/.test(hemisphere) || Number(match[2]) >= 60) return;
	const result = Number(match[1]) + Number(match[2]) / 60;
	if (result > limit) return;
	return hemisphere === negative ? -result : result;
}

function nmeaMotion(speed = '', course = ''): Partial<AprsReport> {
	const report: Partial<AprsReport> = {};
	if (/^\d+(\.\d+)?$/.test(speed)) report.speed = Number(speed) * KNOT;
	if (/^\d+(\.\d+)?$/.test(course) && Number(speed) > 0) report.course = Number(course) || 360;
	return report;
}
