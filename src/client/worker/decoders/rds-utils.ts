// Utility functions extracted from RDSDecoder to reduce file size.
import { rdsChar } from './rds-tables';

export function buildPS(chars: Array<string | null>): string | null {
	if (chars.some((c) => c === null)) return null;
	return (chars as string[]).join('');
}

export function buildRT(chars: Array<string | null>): string | null {
	let s = '';
	for (const char of chars) {
		if (char === null || char === '\r') break;
		s += char;
	}
	return s.trimEnd() || null;
}

export function buildStatus(chars: Array<string | null>, status: number[]): number[] {
	const result: number[] = [];
	for (let i = 0; i < chars.length; i++) {
		if (chars[i] === null || chars[i] === '\r') break;
		result.push(status[i]);
	}
	return result;
}

export function acceptChar(
	pos: number,
	code: number,
	chars: Array<string | null>,
	status: number[],
	quality: number,
	rtChars: Array<string | null>,
	region: string,
): void {
	if (code === 0x0d && chars === rtChars) {
		chars[pos] = '\r';
		return;
	}
	if (code === 0x00) return;
	if (chars[pos] !== null && quality > status[pos]) return;
	chars[pos] = rdsChar(code, region);
	status[pos] = quality;
}
