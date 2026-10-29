import { base91, readable } from './ax25';
import { ambiguityOf, angle, KNOT, validCode, validTable } from './position';
import type { AprsReport } from './types';

// Indexed by the three message bits read as a number: 7 (111) is M0 Off duty, 0 is Emergency.
const STANDARD = ['Emergency', 'Priority', 'Special', 'Committed', 'Returning', 'In service', 'En route', 'Off duty'];

/** Destination character: latitude digit (or ambiguity space), message bit and the N/+100/W flag. */
function destinationCharacter(char: string, flagPosition: boolean) {
	const code = char.charCodeAt(0);
	if (code >= 48 && code <= 57) return { digit: char, bit: 0, custom: false, flag: false };
	if (code === 76) return { digit: ' ', bit: 0, custom: false, flag: false };
	if (code >= 80 && code <= 89) return { digit: String(code - 80), bit: 1, custom: false, flag: true };
	if (code === 90) return { digit: ' ', bit: 1, custom: false, flag: true };
	// Custom message characters A–K are not valid in the flag positions.
	if (flagPosition) return;
	if (code >= 65 && code <= 74) return { digit: String(code - 65), bit: 1, custom: true, flag: false };
	if (code === 75) return { digit: ' ', bit: 1, custom: true, flag: false };
}

function messageStatus(characters: Array<NonNullable<ReturnType<typeof destinationCharacter>>>): string {
	const value = characters[0].bit * 4 + characters[1].bit * 2 + characters[2].bit;
	if (!value) return 'Emergency';
	const set = characters.slice(0, 3).filter((item) => item.bit);
	if (set.every((item) => item.custom)) return `Custom-${7 - value}`;
	return set.some((item) => item.custom) ? 'Unknown' : STANDARD[value];
}

function longitude(info: string, offset: boolean, west: boolean): number | undefined {
	let degrees = info.charCodeAt(1) - 28 + (offset ? 100 : 0);
	if (degrees >= 180 && degrees <= 189) degrees -= 80;
	else if (degrees >= 190 && degrees <= 199) degrees -= 190;
	let minutes = info.charCodeAt(2) - 28;
	if (minutes >= 60) minutes -= 60;
	const hundredths = info.charCodeAt(3) - 28;
	if (degrees < 0 || degrees > 179 || minutes < 0 || minutes > 59 || hundredths < 0 || hundredths > 99) return;
	const value = degrees + (minutes + hundredths / 100) / 60;
	return west ? -value : value;
}

function motion(info: string): Partial<AprsReport> {
	const tens = info.charCodeAt(4) - 28;
	const units = info.charCodeAt(5) - 28;
	let speed = tens * 10 + Math.floor(units / 10);
	if (speed >= 800) speed -= 800;
	let course = (units % 10) * 100 + info.charCodeAt(6) - 28;
	if (course >= 400) course -= 400;
	const report: Partial<AprsReport> = {};
	if (speed >= 0 && speed < 800) report.speed = speed * KNOT;
	// Course 0 is unknown; 360 is north.
	if (course >= 1 && course <= 360) report.course = course;
	return report;
}

/** Mic-E: latitude and message bits in the destination address, longitude and motion in binary info bytes. */
export function decodeMicE(destination: string, info: string): Partial<AprsReport> | undefined {
	const call = destination.split('-')[0];
	if (call.length !== 6 || info.length < 9 || !validCode(info[7]) || !validTable(info[8])) return;
	const characters = [...call].map((char, index) => destinationCharacter(char, index >= 3));
	if (!characters.every((item) => item !== undefined)) return;
	const digits = characters.map((item) => item.digit).join('');
	const ambiguity = ambiguityOf(digits.slice(2));
	if (ambiguity === undefined || !/^\d{2}$/.test(digits.slice(0, 2))) return;
	const latitude = angle(digits.slice(0, 2), digits.slice(2), ambiguity, !characters[3].flag, 90);
	const lon = longitude(info, characters[4].flag, characters[5].flag);
	if (latitude === undefined || lon === undefined) return;
	let rest = info.slice(9);
	let altitude: number | undefined;
	// Optional altitude: three base-91 digits and `}`, metres above −10 km, after an optional radio type byte.
	const encoded = /^(.?)([!-{]{3})\}/.exec(rest);
	if (encoded) {
		altitude = base91(encoded[2])! - 10000;
		rest = encoded[1] + rest.slice(encoded[0].length);
	}
	const comment = readable(rest);
	return {
		format: 'mic-e',
		latitude,
		longitude: lon,
		...(ambiguity ? { ambiguity } : {}),
		symbol: info[8] + info[7],
		...motion(info),
		...(altitude === undefined ? {} : { altitude }),
		...(comment ? { comment } : {}),
		micEStatus: messageStatus(characters),
	};
}
