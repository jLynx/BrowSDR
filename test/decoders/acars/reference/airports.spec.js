import { describe, expect, it } from 'vitest';
import { interpretAcars } from '@/app/decoders/acars/interpret';
import { interpretAcm } from '@/app/decoders/acars/protocols/monitoring';
import { interpretAirbus } from '@/app/decoders/acars/airline';
import { describeAirports } from '@/app/decoders/acars/reference/airports';
import { labelDescription } from '@/app/decoders/acars/catalogue';
import labels from '@/app/decoders/acars/reference/labels.json';

const message = (label, text, extra = {}) => ({
	id: 1,
	registration: 'VH-VFO',
	mode: '2',
	label,
	text,
	receivedAt: Date.parse('2026-10-10T03:00:00Z'),
	acknowledgement: 'NAK',
	blockId: '0',
	messageNumber: 'M16A',
	direction: 'downlink',
	continuation: false,
	...extra,
});
const field = (result, name) => result.fields.find((item) => item.label === name)?.value;

describe('shared ACARS reference coverage', () => {
	it('uses the global dataset directly in ACM and Airbus parsers', () => {
		const acm = interpretAcm('ACM01ACM300BS9V-SNC  SIA285  EGLLKJFK101026  68ER030000');
		expect(field(acm, 'Departure')).toBe('EGLL · London Heathrow Airport');
		expect(field(acm, 'Destination')).toBe('KJFK · John F. Kennedy International Airport');
		const airbus = interpretAirbus(
			'A320,000001,1,1,TB000000/REP001,00,00,1/CCVH-VFO,OCT10,030000,NZWN,NCRG,0296/',
			Date.parse('2026-10-10T03:00:00Z'),
		);
		expect(field(airbus, 'Destination')).toBe('NCRG · Rarotonga International Airport');
	});
	it('names explicitly identified alternate and ATIS airports', () => {
		const result = describeAirports({
			title: 'Airport information',
			coverage: 'partial',
			summary: 'Alternate LHR · ATIS NZQN',
			notes: [],
			fields: [
				{ label: 'Alternate Destination', value: 'LHR' },
				{ label: 'ATIS Airport', value: 'NZQN' },
			],
		});
		expect(field(result, 'Alternate Destination')).toBe('LHR · London Heathrow Airport');
		expect(field(result, 'ATIS Airport')).toBe('NZQN · Queenstown Airport');
	});
	it('names both IATA movement airports while preserving the original message', () => {
		const original = message('80', '\r\nMVA\r\nJST0296/10.VHVFO.WLG\r\nAD0017/0026 EA0131 RAR');
		const result = interpretAcars(original);
		expect(field(result, 'Departure')).toBe('WLG · Wellington International Airport');
		expect(field(result, 'Destination')).toBe('RAR · Rarotonga International Airport');
		expect(result.summary).toContain('RAR · Rarotonga International Airport');
		expect(original.text).toContain('VHVFO.WLG');
	});
	it('does not rename ATC units, flight IDs, raw fields or free text that resemble airport codes', () => {
		const result = {
			title: 'Test',
			coverage: 'partial',
			fields: [
				{ label: 'Destination', value: 'NZWN' },
				{ label: 'Ground address', value: 'NZWN' },
				{ label: 'Reported flight', value: 'RAR' },
			],
			summary: 'Test route NZWN → NZWN',
			notes: [],
		};
		const enriched = describeAirports(result);
		expect(enriched.summary).toBe('Test route NZWN · Wellington International Airport → NZWN · Wellington International Airport');
		expect(field(enriched, 'Ground address')).toBe('NZWN');
		expect(field(enriched, 'Reported flight')).toBe('RAR');
	});
	it('handles the latest operations note using explicit markers and the global RAR lookup', () => {
		const text = 'GOOD AFTERNOONWX RCVD THX. OPS NORMETA RAR 0544HAVE A GOOD 1';
		const result = interpretAcars(message('1L', text));
		expect(result.title).toBe('Operations message');
		expect(field(result, 'Destination')).toBe('RAR · Rarotonga International Airport');
		expect(field(result, 'Estimated arrival')).toBe('05:44 · timezone unspecified');
		expect(interpretAcars(message('1L', text.replace('0544', '2460'))).coverage).toBe('unknown');
		expect(interpretAcars(message('1L', text, { direction: 'uplink' })).coverage).toBe('unknown');
	});
	it('includes every label from the pinned reference while retaining distinct alternate uses', () => {
		expect(Object.keys(labels)).toHaveLength(210);
		for (const code of Object.keys(labels)) expect(labelDescription(code)).toBeDefined();
		expect(labelDescription('Q3').description).toContain('GMT Clock Update');
		expect(labelDescription('B9').description).toContain('Request ATIS information; Flight Plan Information Receipt');
		expect(interpretAcars(message('B9', 'UNRECOGNIZED PAYLOAD')).coverage).toBe('unknown');
		expect(labelDescription('ZZ')).toBeUndefined();
	});
});
