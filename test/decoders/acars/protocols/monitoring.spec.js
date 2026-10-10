import { describe, expect, it } from 'vitest';
import { interpretAcars } from '@/app/decoders/acars/interpret';
import { interpretAcarsLog } from '@/app/decoders/acars/context';
import fixture from './monitoring-fixture.json';

const record = (id, text, extra = {}) => ({
	id,
	receivedAt: Date.parse('2026-10-09T09:19:00Z') + id * 7000,
	registration: 'B-2002',
	mode: '2',
	acknowledgement: 'NAK',
	label: 'H1',
	blockId: String((id + 5) % 10),
	direction: 'downlink',
	messageNumber: `D38${String.fromCharCode(64 + id)}`,
	text,
	continuation: id < 10,
	...extra,
});
const field = (result, label) => result.fields.find((item) => item.label === label)?.value;

// Original A–I boundaries were not supplied; split the received assembly for a synthetic sequence.
function messages() {
	const body = fixture.text.slice(4);
	const final = fixture.finalText.slice(4);
	const prefix = body.slice(0, -final.length);
	const size = Math.ceil(prefix.length / 9);
	return Array.from({ length: 10 }, (_, index) =>
		record(index + 1, '#DFB' + (index === 9 ? final : prefix.slice(index * size, (index + 1) * size))),
	);
}

describe('ACM monitoring report headers', () => {
	it('identifies flight/route while retaining unknown codes and measurements', () => {
		const result = interpretAcars(record(10, fixture.text));
		expect(result).toMatchObject({ title: 'Aircraft monitoring report 51TR', coverage: 'partial' });
		expect(field(result, 'Reported registration')).toBe('B-2002');
		expect(field(result, 'Reported flight code')).toBe('CES780');
		expect(field(result, 'Departure')).toBe('NZAA · Auckland International Airport');
		expect(field(result, 'Destination')).toBe('ZSPD · Shanghai Pudong International Airport');
		expect(field(result, 'Configuration header (raw)')).toBe('ACM211BS');
		expect(field(result, 'Header date code (raw)')).toBe('091026');
		expect(field(result, 'Header time code (raw)')).toBe('091730');
		expect(result.fields.some((item) => /altitude|pressure|speed|temperature|aircraft type|event time/i.test(item.label))).toBe(false);
	});
	it('interprets the complete ten-block assembly and preserves the final received text', () => {
		const blocks = messages();
		const last = interpretAcarsLog(blocks).at(-1);
		expect(last.assembledText).toBe(fixture.text);
		expect(last.text).toBe(fixture.finalText);
		expect(last.interpretation.title).toBe('Aircraft monitoring report 51TR');
		expect(last.interpretation.notes.join(' ')).toContain('Reassembled 10 consecutive blocks');
		expect(last.interpretation.notes.join(' ')).not.toContain('no recognized report header');
		expect(blocks.at(-1).text).toBe(fixture.finalText);
	});
	it('reassembles the supplied batch with its original line breaks intact', () => {
		// The earlier envelope supplies D38A–J; the pasted table supplies the complete block texts.
		const blocks = fixture.receivedBlocks.map((text, index) => record(index + 1, text, { flight: 'MU0780' }));
		const expected = '#DFB' + fixture.receivedBlocks.map((text) => text.slice(4)).join('');
		const results = interpretAcarsLog(blocks);
		expect(results.at(-1).assembledText).toBe(expected);
		expect(expected.replace(/\s/g, '')).toBe(fixture.text.replace(/\s/g, ''));
		expect(results.map((item) => item.text)).toEqual(fixture.receivedBlocks);
		expect(results.at(-1).interpretation.title).toBe('Aircraft monitoring report 51TR');
		for (const result of results.slice(1, -1)) {
			expect(field(result.interpretation, 'Reported flight code (from first block)')).toBe('CES780');
		}
	});
	it('decodes a slashless media advisory in the supplied batch', () => {
		const result = interpretAcars(record(1, '0EV091853VS', { label: 'SA', continuation: false }));
		expect(result).toMatchObject({ title: 'Link advisory', coverage: 'decoded' });
		expect(field(result, 'Link status')).toBe('established');
		expect(field(result, 'Current link')).toBe('VHF ACARS');
		expect(field(result, 'Available links')).toBe('VHF ACARS, Default SATCOM');
		expect(field(result, 'Event time (UTC)')).toBe('2026-10-09 09:18:53 UTC');
	});
	it('associates header context when a block is missing without claiming full assembly', () => {
		const blocks = messages().filter((message) => message.id !== 3);
		const last = interpretAcarsLog(blocks).at(-1);
		expect(last.assembledText).toBeUndefined();
		expect(last.interpretation.coverage).toBe('unknown');
		expect(field(last.interpretation, 'Reported flight code (from first block)')).toBe('CES780');
		expect(last.interpretation.notes.join(' ')).toContain('missing intermediate blocks');
	});
	it('describes a fully assembled unsupported DF report without calling it a fragment', () => {
		const blocks = [record(1, '#DFBUNKNOWN'), record(2, '#DFB12345', { continuation: false })];
		const last = interpretAcarsLog(blocks).at(-1);
		expect(last.interpretation).toMatchObject({ title: 'Aircraft report', coverage: 'unknown' });
		expect(last.interpretation.summary).toContain('Complete DF report received');
		expect(last.interpretation.notes.join(' ')).not.toContain('This block has no recognized report header');
	});
	it('keeps the same numeric fragment undecoded when received on its own', () => {
		expect(interpretAcars(record(10, fixture.finalText))).toMatchObject({ title: 'Aircraft report fragment', coverage: 'unknown' });
	});
	it.each([
		fixture.text.replace('#DFB', '#MDB'),
		fixture.text.slice(0, 30),
		fixture.text.replace('ACM01', 'ACX01'),
		fixture.text.replace('NZAAZSPD', 'NZ1AZSPD'),
	])('does not identify an incompatible or truncated monitoring header', (text) => {
		expect(interpretAcars(record(10, text)).fields.some((item) => item.label === 'Report format')).toBe(false);
	});
});
