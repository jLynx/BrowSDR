import { describe, expect, it } from 'vitest';
import { interpretAcarsLog } from '@/app/decoders/acars/context';

const record = (id, text, extra = {}) => ({
	id,
	receivedAt: Date.parse('2026-10-09T08:00:00Z') + id * 1000,
	registration: 'A7-ANR',
	mode: '2',
	acknowledgement: 'NAK',
	label: 'H1',
	blockId: String(id),
	direction: 'downlink',
	messageNumber: `D15${String.fromCharCode(64 + id)}`,
	text,
	continuation: id === 1,
	...extra,
});
const text = '#MDB/BDOCAYA.ADS.A7-ANR073759D0C997088B86BC1F0D377770C71C488B805B38E698AB9AC88B80A626';
const messages = () => [record(1, text.slice(0, 40)), record(2, '#MDB' + text.slice(40))];

describe('ACARS message reassembly', () => {
	it('decodes complete consecutive blocks, preserving both received fragments', () => {
		const original = messages();
		const results = interpretAcarsLog(original);
		expect(results[1].interpretation.coverage).toBe('decoded');
		expect(results[1].assembledText).toBe(text);
		expect(results.map((item) => item.text)).toEqual(original.map((item) => item.text));
		expect(results[1].interpretation.notes.join(' ')).toContain('D15A, D15B');
	});
	it.each([
		{ messageNumber: 'D15C' },
		{ blockId: '4' },
		{ registration: 'OTHER' },
		{ mode: '1' },
		{ direction: 'uplink' },
		{ label: 'AA' },
		{ receivedAt: Date.parse('2026-10-09T08:04:00Z') },
		{ text: '#DFBwrong' },
	])('does not combine mismatched or incomplete blocks: %s', (extra) => {
		const [first, last] = messages();
		expect(interpretAcarsLog([first, { ...last, ...extra }])[1].assembledText).toBeUndefined();
	});
	it('does not combine separate VFO logs, incomplete starts or conflicting flights', () => {
		const [first, last] = messages();
		interpretAcarsLog([first]);
		expect(interpretAcarsLog([last])[0].assembledText).toBeUndefined();
		for (const start of [
			{ ...first, continuation: false },
			{ ...first, flight: 'ABC1' },
		])
			expect(interpretAcarsLog([start, { ...last, flight: 'ABC2' }])[1].assembledText).toBeUndefined();
	});
	it('tolerates exact retransmissions and wraps numeric block IDs', () => {
		const [first, last] = messages();
		const result = interpretAcarsLog([
			{ ...first, blockId: '9' },
			{ ...first, id: 3, blockId: '9' },
			{ ...last, blockId: '0' },
		]);
		expect(result.at(-1).assembledText).toBe(text);
	});
	it('bounds assembled text and requires a final ETX', () => {
		const [first, last] = messages();
		expect(interpretAcarsLog([first, { ...last, continuation: true }])[1].assembledText).toBeUndefined();
		expect(interpretAcarsLog([{ ...first, text: '#MDB' + 'X'.repeat(8192) }, last])[1].assembledText).toBeUndefined();
	});
});
