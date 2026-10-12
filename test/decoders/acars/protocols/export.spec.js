import { describe, expect, it } from 'vitest';
import { interpretAcars } from '@/app/decoders/acars/interpret';
import { interpretAcarsLog } from '@/app/decoders/acars/context';
import fixture from './export-fixture.json';

const first = fixture[0][0];
const field = (result, label) => result.fields.find((item) => item.label === label)?.value;
const sample = (label, text, extra = {}) => ({ ...first, label, text, continuation: false, ...extra });

describe('10 October ACARS export regressions', () => {
	it('assembles the actual A320 A/B/C report across an intervening 2L message', () => {
		const blocks = fixture[0].filter((m) => m.id <= 30);
		const results = interpretAcarsLog(blocks);
		const final = results.at(-1);
		expect(final.assembledText).toBe(
			'#DFB' +
				blocks
					.filter((m) => m.label === 'H1')
					.map((m) => m.text.slice(4))
					.join(''),
		);
		expect(final.interpretation.title).toBe('A320 aircraft report 004');
		expect(final.interpretation.notes.join(' ')).toContain('D07A, D07B, D07C');
		expect(final.text).toBe(blocks.at(-1).text);
	});
	it('identifies the multiline A330 R/C1 header without guessing measurements or a timezone', () => {
		const report = fixture[0].find((m) => m.id === 80);
		const result = interpretAcars(report);
		expect(result.title).toBe('A330 aircraft report 02');
		expect(field(result, 'Reported registration')).toBe('DQ-FJW');
		expect(field(result, 'Reported flight code')).toBe('FJI411');
		expect(field(result, 'Departure')).toBe('NFFN · Nadi International Airport');
		expect(field(result, 'Reported date/time')).toBe('2026-10-09 23:22:01 · timezone unspecified');
		expect(result.fields.some((f) => /altitude|temperature|UTC|local/i.test(f.label))).toBe(false);
		expect(interpretAcars({ ...report, text: report.text.replace('26OCT09', '26FEB31') }).coverage).toBe('unknown');
	});
	it('identifies routed angle-bracket headers and associates numeric fragments while rejecting missing letters', () => {
		const blocks = fixture[1].filter((m) => [314, 327, 346].includes(m.id));
		const results = interpretAcarsLog(blocks);
		expect(results[0].interpretation.title).toBe('Aircraft report IEG10');
		expect(field(results[0].interpretation, 'Departure')).toBe('NZAA · Auckland International Airport');
		expect(field(results[1].interpretation, 'Report code (from first block)')).toBe('IEG10');
		expect(results.at(-1).assembledText).toBeUndefined();
		expect(results.at(-1).interpretation.notes.join(' ')).toContain('Expected message block D87C; received D87K');
	});
	it.each([421, 424])('identifies Singapore ACM headers with alphanumeric registrations (%s)', (id) => {
		const result = interpretAcars(fixture[1].find((m) => m.id === id));
		expect(result.title).toBe('Aircraft monitoring report 68ER');
		expect(field(result, 'Reported registration')).toBe('9V-SNC');
		expect(field(result, 'Configuration header (raw)')).toMatch(/^ACM(?:300BS|230FS)$/);
		expect(field(result, 'Departure')).toBe('WSSS · Singapore Changi Airport');
		expect(result.coverage).toBe('partial');
	});
	it('decodes the real MIAM CORE header but leaves the missing compressed body undecoded', () => {
		const report = fixture[1].find((m) => m.id === 322);
		const result = interpretAcars(report);
		expect(result).toMatchObject({ title: 'MIAM application transfer', coverage: 'partial' });
		expect(field(result, 'Embedded label / sublabel / function')).toBe('H1 / CF');
		expect(field(result, 'Compression')).toBe('Deflate');
		expect(field(result, 'Encoding')).toBe('ISO #5 text');
		expect(field(result, 'Declared PDU length')).toBe('424 bytes');
		expect(field(result, 'Application message number')).toBe('102');
		expect(result.notes.join(' ')).toContain('requires its final ETX');
		expect(report.text).toContain('T22!<</!');
	});
	it('decodes the actual MIAM acknowledgement separately from link acknowledgements', () => {
		const result = interpretAcars({ ...fixture[1].find((m) => m.id === 448), messageNumber: undefined, flight: undefined });
		expect(result).toMatchObject({ title: 'MIAM transfer acknowledgement', coverage: 'decoded' });
		expect(field(result, 'Acknowledged application message')).toBe('38');
		expect(field(result, 'Transfer result')).toBe('Acknowledged');
	});
	it.each(['T22!|data', 'T22uuuuu|data', 'T22z!|data', 'T22!!!!!|data'])('rejects malformed MIAM headers: %s', (text) => {
		expect(interpretAcars(sample('MA', text)).coverage).toBe('unknown');
	});
	it('recognizes airport ATIS requests and empty VDL switch advisories', () => {
		expect(field(interpretAcars(sample('5D', 'NZCH')), 'Requested airport (ICAO)')).toBe('NZCH · Christchurch International Airport');
		expect(interpretAcars(sample('5D', 'NZCH', { direction: 'uplink' })).coverage).toBe('unknown');
		expect(interpretAcars(sample('5D', 'NZCH extra')).coverage).toBe('unknown');
		expect(interpretAcars(sample('5V', '')).title).toBe('VDL switch advisory');
	});
	it('extracts movement fields and midnight clocks without assigning complete dates', () => {
		const text = '\r\nMVA\r\nJST0233/10.VHX3J.AKL\r\nAD0017/0026 EA0131 CHC';
		const result = interpretAcars(sample('80', text));
		expect(result.title).toBe('Movement report');
		expect(field(result, 'Gate departure (AD first clock)')).toBe('00:17 · timezone unspecified');
		expect(field(result, 'Takeoff (AD second clock)')).toBe('00:26 · timezone unspecified');
		expect(field(result, 'Estimated arrival (EA)')).toBe('01:31 · timezone unspecified');
		expect(interpretAcars(sample('80', text.replace('EA0131', 'EA2460'))).coverage).toBe('unknown');
		expect(interpretAcars(sample('80', text, { direction: 'uplink' })).coverage).toBe('unknown');
	});
	it('extracts TAC header fields without expanding its unknown codes', () => {
		const result = interpretAcars(sample('1L', 'TAC/AKL/0208/6400  /  / /   /               /    /                  \r\n      '));
		expect(result.title).toBe('Airline TAC report');
		expect(field(result, 'Airport code')).toBe('AKL · Auckland International Airport');
		expect(field(result, 'TAC value (raw)')).toBe('6400');
		expect(result.fields.some((f) => /fuel|kg|weight|UTC/i.test(f.label))).toBe(false);
	});
});
