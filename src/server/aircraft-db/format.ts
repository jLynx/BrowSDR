import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export const aircraftFields = [9, 33, 33, 5, 33, 33];
export const airlineFields = [32, 32];

export function digest(data: Uint8Array | string) {
	return createHash('sha256').update(data).digest('hex');
}

export function fixedField(value: string, width: number) {
	const field = Buffer.alloc(width);
	const ascii = [...value.normalize('NFKD')].filter((character) => character.charCodeAt(0) < 128).join('');
	field.write(ascii.slice(0, width - 1), 'ascii');
	return field;
}

export function database(rows: Map<string, string[]>, keyWidth: number, widths: number[]) {
	const sorted = [...rows].sort(([a], [b]) => a.localeCompare(b, 'en'));
	const keys = sorted.map(([key]) => fixedField(key, keyWidth));
	const values = sorted.map(([, fields]) => Buffer.concat(fields.map((value, index) => fixedField(value, widths[index]))));
	return Buffer.concat([...keys, ...values]);
}

export function contentRevision(files: Record<string, { sha256: string }>) {
	// Match the standard-library Python builder's sorted JSON including separators.
	const entries = Object.keys(files)
		.sort()
		.map((name) => `${JSON.stringify(name)}: ${JSON.stringify(files[name].sha256)}`);
	return digest(`{${entries.join(', ')}}`).slice(0, 24);
}
