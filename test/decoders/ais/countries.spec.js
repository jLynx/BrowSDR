import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { maritimeMid } from '@/app/decoders/ais/database';

describe('bundled ITU country allocations', () => {
	it('contains complete grouped and shared allocations with a matching UTF-8 revision', () => {
		const source = readFileSync('public/maritime-db/mids.json', 'utf8');
		const value = JSON.parse(source);
		expect(source).not.toContain('\uFFFD');
		expect(value.schema).toBe(1);
		expect(Object.keys(value.mids)).toHaveLength(292);
		expect(value.revision).toBe(createHash('sha256').update(JSON.stringify(value.mids)).digest('hex').slice(0, 24));
		for (const mid of ['563', '564', '565', '566']) expect(value.mids[mid]).toBe('Singapore (Republic of)');
		expect(value.mids['306']).toContain('Curaçao');
		expect(value.mids['306']).toContain('Bonaire, Sint Eustatius and Saba');
		expect(value.mids['306']).toContain('Sint Maarten (Dutch part)');
		expect(value.mids[maritimeMid('566278000')]).toBe('Singapore (Republic of)');
		expect(value.mids[maritimeMid('512001106')]).toBe('New Zealand');
	});
});
