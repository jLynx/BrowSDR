import { describe, expect, it } from 'vitest';
import { interpretAcars } from '@/app/decoders/acars/interpret';

const text = '.HDQMQKE 092029\nAGM\nAN HL8575\n-  ARRIVAL ACK\n LD 2010   RI 2023 \n REMAIN FUEL   22200';
const record = (payload, extra = {}) => ({
	id: 1,
	receivedAt: Date.parse('2026-10-09T20:29:48Z'),
	registration: 'HL8575',
	mode: '2',
	acknowledgement: '6',
	label: 'C1',
	blockId: 'S',
	direction: 'uplink',
	text: payload,
	continuation: false,
	...extra,
});
const field = (result, label) => result.fields.find((item) => item.label === label)?.value;

describe('ground arrival acknowledgements', () => {
	it.each([text, text.replace(/\s+/g, ' ')])('extracts arrival data without assigning unreported units or timezone', (payload) => {
		const message = record(payload);
		const result = interpretAcars(message);
		expect(result).toMatchObject({ title: 'Arrival acknowledgement', coverage: 'partial' });
		expect(field(result, 'Reported registration')).toBe('HL8575');
		expect(field(result, 'Ground address')).toBe('HDQMQKE');
		expect(field(result, 'LD time code')).toBe('20:10 · timezone unspecified');
		expect(field(result, 'RI time code')).toBe('20:23 · timezone unspecified');
		expect(field(result, 'Remaining fuel (raw)')).toBe('22200 · units unspecified');
		expect(result.fields.some((item) => /UTC|local|Landing time|Gate arrival/.test(item.label))).toBe(false);
		expect(message.text).toBe(payload);
	});
	it.each([
		text.replace('2010', '2410'),
		text.replace('2023', '2060'),
		text.replace('22200', 'UNKNOWN'),
		text.replace('22200', ''),
		text + ' EXTRA',
	])('does not interpret malformed or additional payload data', (payload) => {
		expect(interpretAcars(record(payload)).title).not.toBe('Arrival acknowledgement');
	});
	it.each([{ direction: 'downlink' }, { label: 'C2' }])('restricts the observed layout to uplink C1', (extra) => {
		expect(interpretAcars(record(text, extra)).title).not.toBe('Arrival acknowledgement');
	});
	it('keeps the unknown uplink label-41 encoding uninterpreted', () => {
		const payload = 'MSG0207).k4.0U)-]XX${]) 6 Y{}y%* $E%6.4U.%En$$is}}}%YX%$s$Y $x ]%6?(%O* YEl';
		const result = interpretAcars(record(payload, { registration: 'VPCJR', label: '41', blockId: 'V' }));
		expect(result.coverage).toBe('unknown');
		expect(result.fields).toEqual([{ label: 'Message category', value: 'ACARS message (41)' }]);
	});
});
