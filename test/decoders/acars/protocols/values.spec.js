import { describe, expect, it } from 'vitest';
import { Bits } from '@jlynx_/acars-decoder/formats';
import { altitude, speed, time, position, frequency, altimeter } from '@jlynx_/acars-decoder/formats';
import { decodeCpdlc } from '@jlynx_/acars-decoder';

function packed(...parts) {
	let binary = parts.map(([width, value]) => value.toString(2).padStart(width, '0')).join('');
	binary = binary.padEnd(Math.ceil(binary.length / 8) * 8, '0');
	return Uint8Array.from(binary.match(/.{8}/g), (value) => parseInt(value, 2));
}

describe('FANS parameter units and validation', () => {
	it('applies libacars QNH feet scale rather than displaying encoded tens', () =>
		expect(altitude(new Bits(packed([3, 0], [12, 1500])))).toBe('15000 ft (QNH)'));
	it('decodes flight levels and IAS scale', () => {
		expect(altitude(new Bits(packed([3, 6], [10, 320])))).toBe('FL350');
		expect(speed(new Bits(packed([3, 0], [5, 18])))).toBe('250 kt (IAS)');
	});
	it('decodes an instruction with two altitudes', () => {
		const bytes = packed([1, 0], [1, 0], [1, 0], [6, 4], [8, 30], [3, 6], [10, 320], [3, 6], [10, 340]);
		expect(decodeCpdlc(bytes, 'uplink')).toMatchObject({ complete: true, summary: 'MAINTAIN BLOCK FL350 TO FL370' });
	});
	it('decodes multiple elements without confusing body boundaries', () => {
		const bytes = packed([1, 1], [1, 0], [1, 0], [6, 4], [8, 19], [3, 6], [10, 320], [2, 0], [8, 3]);
		expect(decodeCpdlc(bytes, 'uplink')).toMatchObject({ complete: true, summary: 'MAINTAIN FL350 · ROGER' });
	});
	it('preserves unsupported route bodies as partial instructions', () => {
		const bytes = packed([1, 0], [1, 0], [1, 0], [6, 4], [8, 80]);
		expect(decodeCpdlc(bytes, 'uplink').complete).toBe(false);
	});
	it('rejects invalid constrained clock, altitude and position fields', () => {
		expect(() => time(new Bits(packed([5, 24], [6, 0])))).toThrow();
		expect(() => altitude(new Bits(packed([3, 6], [10, 900])))).toThrow();
		expect(() => position(new Bits(packed([3, 5])))).toThrow();
	});
	it('decodes frequency and pressure units from constrained PER values', () => {
		expect(frequency(new Bits(packed([2, 1], [15, 14550])))).toBe('131.550 MHz');
		expect(altimeter(new Bits(packed([1, 1], [13, 2632])))).toBe('1013.2 hPa');
		expect(altimeter(new Bits(packed([1, 0], [10, 792])))).toBe('29.92 inHg');
	});
	it('rejects unused frequency and pressure encodings rather than inventing values', () => {
		expect(() => frequency(new Bits(packed([2, 0], [15, 25151])))).toThrow();
		expect(() => frequency(new Bits(packed([2, 1], [15, 21001])))).toThrow();
		expect(() => frequency(new Bits(packed([2, 2], [18, 174976])))).toThrow();
		expect(() => altimeter(new Bits(packed([1, 1], [13, 5001])))).toThrow();
		expect(() => altimeter(new Bits(packed([1, 0], [10, 1001])))).toThrow();
	});
});
