import { describe, expect, it } from 'vitest';
import { interpretAcars } from '@/app/decoders/acars/interpret';
import { datedTime, monthDayTime } from '@jlynx_/acars-decoder/formats';

const load = 'DAT 09OCT26 UTC 0810 REG VHX3B FLT JST241 GWT 0 ZFW 595 FOB    87 CAP 129668 FO  435525 LOG 502304 LDR 0 DRT 0753';
const airbus =
	'#DFBA320,011130,1,1,TB000000/REP004,00,00,1/CCVH-X3B,OCT09,081050,NZAA,NZCH,0241/C0TIA05JST130000/C105,01404,4000,45,0010,0,0100,45,X/CE0183,00592,156,239,6816,304,I21T13/EC016018,41939,19476,D3/EE016577,02595,';
const fragment =
	'#DFB01549,D3/N101,00,00,00,00,00,01,00,00,5165,5165/N201,00,00,00,00,00,01,00,00,5170,5175/S11337,5165,0843,0900,3783,1412,1337/S21337,5170,0843,0903,3781,1412,1337/T13551,5013,028,14961,0192,20434/T23561,4998,';
const record = (label, text, extra = {}) => ({
	id: 1,
	receivedAt: Date.parse('2026-10-09T08:11:23Z'),
	registration: 'VH-X3B',
	mode: '2',
	acknowledgement: 'NAK',
	label,
	blockId: '8',
	direction: 'downlink',
	messageNumber: 'D15A',
	text,
	continuation: false,
	...extra,
});
const field = (result, label) => result.fields.find((item) => item.label === label)?.value;

describe('received airline ACARS reports', () => {
	it('explains the operations note without inventing an ETA timezone or expanding TX', () => {
		const result = interpretAcars(record('1L', 'WX RCVD TXOPS NORMALETA MEL 1130'));
		expect(result).toMatchObject({ title: 'Operations message', coverage: 'partial' });
		expect(field(result, 'Weather')).toBe('WX RCVD · weather received');
		expect(field(result, 'Operations')).toBe('Normal');
		expect(field(result, 'Destination')).toBe('MEL · Melbourne Airport');
		expect(field(result, 'Estimated arrival')).toBe('11:30 · timezone unspecified');
		expect(result.fields.some((item) => item.label.includes('UTC'))).toBe(false);
		expect(result.notes.join(' ')).toContain('TX token is not expanded');
	});
	it('recognizes spaced operations text and leaves unknown destination codes as reported', () => {
		const result = interpretAcars(record('1L', 'WX RCVD TXOPS NORMAL ETA XYZ 0130'));
		expect(field(result, 'Destination')).toBe('XYZ');
		expect(field(result, 'Estimated arrival')).toBe('01:30 · timezone unspecified');
	});
	it.each([
		'WX RCVD TXOPS NORMALETA MEL 2400',
		'WX RCVD TXOPS NORMALETA MEL 1160',
		'WX RCVD TXOPS NORMALETA MEL 1130 extra',
		'TAC/MEL/1325/',
		'WX RCVD',
	])('does not apply the operations parser to unsupported text: %s', (text) => {
		expect(interpretAcars(record('1L', text)).coverage).toBe('unknown');
	});
	it('extracts date, aircraft, flight, crew IDs and raw load fields from the 2L sample', () => {
		const message = record('2L', load);
		const result = interpretAcars(message);
		expect(result).toMatchObject({ title: 'Flight/load report', coverage: 'partial' });
		expect(field(result, 'Reported registration')).toBe('VHX3B');
		expect(field(result, 'Reported flight')).toBe('JST241');
		expect(field(result, 'Event time (UTC)')).toBe('2026-10-09 08:10 UTC');
		expect(field(result, 'Gross weight (GWT, raw)')).toBe('0');
		expect(field(result, 'Zero-fuel weight (ZFW, raw)')).toBe('595');
		expect(field(result, 'Fuel on board (FOB, raw)')).toBe('87');
		expect(field(result, 'Captain identifier (CAP)')).toBe('129668');
		expect(field(result, 'First officer identifier (FO)')).toBe('435525');
		expect(field(result, 'LOG (raw)')).toBe('502304');
		expect(field(result, 'LDR (raw)')).toBe('0');
		expect(field(result, 'DRT (raw)')).toBe('0753');
		expect(result.summary).toContain('raw values; units unspecified');
		expect(message.text).toBe(load);
	});
	it('retains repeated reports as independent records with identical interpreted content', () => {
		const first = record('2L', load, { id: 1, messageNumber: 'M28A', blockId: '6' });
		const second = record('2L', load, { id: 2, messageNumber: 'M29A', blockId: '7' });
		expect(interpretAcars(first)).toEqual(interpretAcars(second));
		expect(first.id).not.toBe(second.id);
	});
	it('decodes multiline load reports while preserving their received text', () => {
		const text =
			'DAT 09OCT26\nUTC 2024\nREG VHVGA\nFLT JST283\nGWT 0\nZFW 574\nFOB   110\nCAP 163145\nFO  437049\nLOG 513429\nLDR 0\nDRT 2014';
		const message = record('2L', text);
		const result = interpretAcars(message);
		expect(result.title).toBe('Flight/load report');
		expect(field(result, 'Event time (UTC)')).toBe('2026-10-09 20:24 UTC');
		expect(field(result, 'Fuel on board (FOB, raw)')).toBe('110');
		expect(message.text).toBe(text);
		expect(interpretAcars(record('2L', 'DAT 09OCT26\nUTC 2024\nREG VHVGA')).coverage).toBe('unknown');
	});
	it.each([
		load.replace('09OCT26', '31FEB26'),
		load.replace('0810', '2460'),
		load.replace('FOB    87', 'FOB    UNKNOWN'),
		load.slice(0, -3),
		`${load} EXTRA`,
		'P/2357/290-/\n+52.7+15.5/-43/2/5',
	])('leaves malformed and different label-2L layouts unparsed: %s', (text) => {
		expect(interpretAcars(record('2L', text)).coverage).toBe('unknown');
	});
	it('extracts the A320 report header and keeps measurements uninterpreted', () => {
		const message = record('H1', airbus, { continuation: true });
		const result = interpretAcars(message);
		expect(result).toMatchObject({ title: 'A320 aircraft report 004', coverage: 'partial' });
		expect(field(result, 'H1 sublabel')).toBe('DF');
		expect(field(result, 'Reported registration')).toBe('VH-X3B');
		expect(field(result, 'Reported flight code')).toBe('0241');
		expect(field(result, 'Departure')).toBe('NZAA · Auckland International Airport');
		expect(field(result, 'Destination')).toBe('NZCH · Christchurch International Airport');
		expect(field(result, 'Event time (UTC)')).toBe('2026-10-09 08:10:50 UTC');
		expect(field(result, 'Configuration header (raw)')).toBe('011130,1,1,TB000000');
		expect(field(result, 'Report header (raw)')).toBe('00,00,1');
		expect(result.fields.some((item) => item.value.includes('6816'))).toBe(false);
		expect(result.notes.join(' ')).toContain('not reassembled');
		expect(message.text).toBe(airbus);
	});
	it('keeps the next DF block as a separate fragment without borrowing the previous route or aircraft', () => {
		const result = interpretAcars(record('H1', fragment, { messageNumber: 'D15B', blockId: '9', continuation: true }));
		expect(result.title).toBe('Aircraft report fragment');
		expect(result.fields).toEqual([{ label: 'H1 sublabel', value: 'DF' }]);
		expect(result.notes.join(' ')).toContain('not reassembled');
	});
	it.each([airbus.replace('OCT09', 'FEB31'), airbus.replace('081050', '246000'), airbus.slice(0, 50)])(
		'does not interpret an invalid/truncated Airbus header',
		(text) => {
			expect(interpretAcars(record('H1', text)).title).toBe('Aircraft report fragment');
		},
	);
	it('restricts the airline-specific formats to their labels and directions', () => {
		expect(interpretAcars(record('H1', load)).coverage).toBe('unknown');
		expect(interpretAcars(record('2L', load, { direction: 'uplink' })).coverage).toBe('unknown');
		expect(interpretAcars(record('1L', 'WX RCVD TXOPS NORMALETA MEL 1130', { direction: 'uplink' })).coverage).toBe('unknown');
	});
});

describe('dated airline report timestamps', () => {
	it('uses the explicit report date instead of the receipt date', () => {
		expect(datedTime('09OCT26', '0810')).toBe(Date.parse('2026-10-09T08:10:00Z'));
		expect(datedTime('29FEB28', '235959')).toBe(Date.parse('2028-02-29T23:59:59Z'));
	});
	it.each([
		['29FEB26', '0810'],
		['31APR26', '0810'],
		['00OCT26', '0810'],
		['09XYZ26', '0810'],
		['09OCT26', '2400'],
		['09OCT26', '0860'],
		['09OCT26', '081060'],
		['09OCT26', '081'],
	])('rejects invalid dates/times %s %s', (date, clock) => {
		expect(datedTime(date, clock)).toBeUndefined();
	});
	it('infers the nearest year for month/day report dates across New Year', () => {
		expect(monthDayTime('DEC31', '235959', Date.parse('2027-01-01T00:01:00Z'))).toBe(Date.parse('2026-12-31T23:59:59Z'));
		expect(monthDayTime('JAN01', '000100', Date.parse('2026-12-31T23:59:59Z'))).toBe(Date.parse('2027-01-01T00:01:00Z'));
		expect(monthDayTime('FEB31', '081000', Date.parse('2026-10-09T08:11:00Z'))).toBeUndefined();
		expect(monthDayTime('OCT09', '081000', NaN)).toBeUndefined();
	});
});
