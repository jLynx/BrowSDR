import { describe, expect, it } from 'vitest';
import { interpretAcars } from '@/app/decoders/acars/interpret';
import { interpretText } from '@/app/decoders/acars/protocols/text';

const record = (label, text, direction = 'downlink') => ({
	id: 1,
	receivedAt: 1791532800000,
	registration: 'ZK-NZE',
	mode: '2',
	acknowledgement: 'NAK',
	label,
	blockId: '1',
	direction,
	text,
	continuation: false,
});
const field = (result, name) => result.fields.find((item) => item.label === name)?.value;

describe('combined text payload formats', () => {
	it.each(['21', '22', '31', '36', '44'])('extracts explicit decimal coordinates on label %s', (label) => {
		const result = interpretText(record(label, 'N28.282 W82.571'));
		expect(field(result, 'Latitude')).toBe('28.282°');
		expect(field(result, 'Longitude')).toBe('-82.571°');
	});
	it('keeps other numeric position telemetry uninterpreted', () => {
		const result = interpretText(record('21', 'POSN N28.282 W82.571, 266,154806,10434,25363, 29, 6,174854,KCLE'));
		expect(result.coverage).toBe('partial');
		expect(field(result, 'Altitude')).toBeUndefined();
	});
	it('ports the Python general aviation position/date layout', () => {
		const result = interpretAcars(record('15', '(2S37306E174100OFF0910260809(Z'));
		expect(field(result, 'Latitude')).toBe('-37.306°');
		expect(field(result, 'Event time (UTC)')).toBe('2026-10-09 08:09 UTC');
	});
	it.each(['(2S90306E174100(Z', '(2S37306E184100(Z', '(2S37306E174100OFF3111260809(Z', '(2S37306E174100OFF0910262460(Z'])(
		'rejects invalid GA payload %s',
		(text) => expect(interpretText(record('15', text))).toBeUndefined(),
	);
	it('explains a frequency change without retuning the radio', () => {
		const result = interpretAcars(record(':;', '131550', 'uplink'));
		expect(field(result, 'Requested frequency')).toBe('131.550 MHz');
		expect(result.notes.join(' ')).toContain('does not retune');
		expect(interpretText(record(':;', '999550', 'uplink'))).toBeUndefined();
	});
	it('extracts explicitly named maintenance measurements and their transmitted units', () => {
		const result = interpretAcars(
			record('H1', '#CFBMDC REPORT: ENGINE TREND\nL N1 84.1 %\nR N1 85.2 %\nL ITT 700 C\nR FUEL FLOW 2400 PPH\nUNKNOWN 444'),
		);
		expect(result.title).toBe('Engine trend report');
		expect(field(result, 'Left engine N1')).toBe('84.1 %');
		expect(field(result, 'Right engine Fuel flow')).toBe('2400 PPH');
		expect(result.coverage).toBe('partial');
	});
});
