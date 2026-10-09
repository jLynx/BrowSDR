import { describe, expect, it } from 'vitest';
import { interpretAcars } from '@/app/decoders/acars/interpret';
import { messageTime, timeFields } from '@/app/decoders/acars/time';

const receivedAt = Date.parse('2026-10-09T07:50:00Z');
const record = (label, text, extra = {}) => ({
	id: 1,
	receivedAt,
	registration: 'B-1466',
	mode: '2',
	acknowledgement: '3',
	label,
	blockId: '1',
	direction: 'downlink',
	flight: 'CA0568',
	text,
	continuation: false,
	...extra,
});
const field = (result, name) => result.fields.find((item) => item.label === name)?.value;

describe('ACARS payload interpretation', () => {
	it('explains empty frame acknowledgements without treating every empty payload as an ACK', () => {
		const result = interpretAcars(record('_d', ''));
		expect(result).toMatchObject({ title: 'Acknowledgement', coverage: 'decoded', summary: 'Acknowledges receipt of block 3.' });
		expect(interpretAcars(record('_d', '', { acknowledgement: 'NAK' })).title).toBe('Negative acknowledgement');
		expect(interpretAcars(record('H1', '')).coverage).toBe('unknown');
	});
	it('decodes the received link advisory, UTC time and available links', () => {
		const result = interpretAcars(record('SA', '0EV074755VS/'));
		expect(result).toMatchObject({ title: 'Link advisory', coverage: 'decoded' });
		expect(result.summary).toContain('VHF ACARS link established');
		expect(field(result, 'Available links')).toBe('VHF ACARS, Default SATCOM');
		expect(field(result, 'Event time (UTC)')).toBe('2026-10-09 07:47:55 UTC');
		expect(field(result, 'Event time (local)')).toBeTruthy();
		expect(interpretAcars(record('SA', '0LH074755HI/extra text')).summary).toContain('HF link lost');
		expect(field(interpretAcars(record('SA', '0LH074755HI/extra text')), 'Additional text')).toBe('extra text');
	});
	it.each(['1EV074755VS/', '0QV074755VS/', '0EV244755VS/', '0EV076055VS/', '0EV074760VS/', '0EV0747', ''])(
		'leaves malformed advisory %s unparsed',
		(text) => {
			expect(interpretAcars(record('SA', text)).coverage).toBe('unknown');
		},
	);
	it('marks unknown link codes as partial without inventing link types', () => {
		expect(interpretAcars(record('SA', '0EZ074755VZ/'))).toMatchObject({ coverage: 'partial' });
		expect(field(interpretAcars(record('SA', '0EZ074755VZ/')), 'Current link')).toBe('Unknown link (Z)');
	});
	it('extracts the received wheels-off report while preserving undocumented fields', () => {
		const message = record('10', 'OFF090746,NZAA,ZBAA,190700,*,LT,0800,090736');
		const result = interpretAcars(message);
		expect(result).toMatchObject({ title: 'Wheels-off report', coverage: 'partial' });
		expect(field(result, 'Departure')).toBe('NZAA · Auckland Airport');
		expect(field(result, 'Destination')).toBe('ZBAA · Beijing Capital Airport');
		expect(field(result, 'Event time (UTC)')).toBe('2026-10-09 07:46:00 UTC');
		expect(message.text).toBe('OFF090746,NZAA,ZBAA,190700,*,LT,0800,090736');
		expect(result.fields).toHaveLength(5);
	});
	it.each(['OFF090746,NZAA,ZBAA', 'OFF092546,NZAA,ZBAA,190700,*,LT,0800,090736', 'ARR01 airline data'])(
		'does not assign a universal format to label 10 (%s)',
		(text) => {
			expect(interpretAcars(record('10', text)).coverage).toBe('unknown');
		},
	);
	it.each(['TOIC', 'ICCL'])('extracts %s report headers without guessing numeric units', (code) => {
		const result = interpretAcars(record('49', `01${code}    CCA568/090746NZAAZBAA\r\n+  123191.4+ 21.1`));
		expect(field(result, 'Report code')).toBe(code);
		expect(field(result, 'Reported flight')).toBe('CCA568');
		expect(field(result, 'Destination')).toBe('ZBAA · Beijing Capital Airport');
		expect(result.coverage).toBe('partial');
		expect(result.fields.some((item) => item.value.includes('21.1'))).toBe(false);
	});
	it('recognizes DF sublabel, report headers and separately received fragments', () => {
		const result = interpretAcars(
			record('H1', '#DFB<402>HER\n9   2 B-1466CCA568    PO 379091026073614NZAAZBAA43856\nCCA3AACMFC001  19 1023  19', {
				continuation: true,
			}),
		);
		expect(result.title).toBe('Aircraft report HER');
		expect(field(result, 'H1 sublabel')).toBe('DF');
		expect(field(result, 'Report ID')).toBe('402');
		expect(field(result, 'Departure')).toBe('NZAA · Auckland Airport');
		expect(result.notes.join(' ')).toContain('not reassembled');
		const fragment = interpretAcars(record('H1', '#DFB  99  90 22\n 37 38 98 89 22'));
		expect(fragment.title).toBe('Aircraft report fragment');
		expect(field(fragment, 'Departure')).toBeUndefined();
	});
	it.each([
		['AA', 'CR1', 'CPDLC connection request', '209F14E8E75AB53C06BF'],
		['A6', 'ADS', 'ADS-C message', '07000BCD0C000D010E0110010F01150001080112B2131AA91A13140A28E844'],
	])('extracts the received ARINC %s envelope with the fixed-length padded address', (mfi, application, title, hex) => {
		const result = interpretAcars(record('H1', `- #MD/${mfi} AKLCDYA.${application}.NZ7013${hex}`, { direction: 'uplink' }));
		expect(result).toMatchObject({ title, coverage: 'partial' });
		expect(field(result, 'H1 sublabel')).toBe('MD');
		expect(field(result, 'Message function')).toBe(mfi);
		expect(field(result, 'Aircraft address')).toBe('NZ7013');
		expect(field(result, 'Ground address')).toBe('AKLCDYA');
		expect(field(result, 'Application data (hex)')).toBe(hex.slice(0, -4));
		expect(field(result, 'Application CRC (unchecked)')).toBe(hex.slice(-4));
		expect(result.notes.join(' ')).toContain('not decoded');
	});
	it.each(['AT1', 'CC1', 'DR1', 'DIS'])('recognizes direct ARINC application %s with a four-character ground address', (application) => {
		const result = interpretAcars(record('AA', `/ABCD.${application}.ZK-NZE0000`));
		expect(result.coverage).toBe('partial');
		expect(field(result, 'Application')).toBe(`${application} · ARINC 622`);
		expect(field(result, 'Aircraft address')).toBe('ZK-NZE');
	});
	it.each(['AKLCDYA.CR1.NZ7013209', 'AKLCDYA.CR1.NZ7013ZZZZ', 'AKLCDYA.CR1.NZ701300', 'AKLCDYA.XYZ.NZ70130000', '#DF'])(
		'leaves truncated or malformed application data unparsed: %s',
		(text) => {
			expect(interpretAcars(record('H1', text)).coverage).toBe('unknown');
		},
	);
	it('preserves arbitrary radio text, including literal HTML entities and unknown airports', () => {
		const message = record('H1', '<script>alert(1)</script>&#xA;');
		expect(interpretAcars(message).coverage).toBe('unknown');
		expect(message.text).toBe('<script>alert(1)</script>&#xA;');
		expect(field(interpretAcars(record('10', 'OFF090746,ZZZZ,YYYY,190700,*,LT,0800,090736')), 'Departure')).toBe('ZZZZ');
	});
});

describe('inferred ACARS timestamps', () => {
	it('uses the closest UTC day across midnight', () => {
		expect(messageTime('235959', Date.parse('2026-10-10T00:01:00Z'), 'HHMMSS')).toBe(Date.parse('2026-10-09T23:59:59Z'));
		expect(messageTime('000100', Date.parse('2026-10-09T23:59:00Z'), 'HHMMSS')).toBe(Date.parse('2026-10-10T00:01:00Z'));
	});
	it('handles month/year boundaries and leap days without rolling invalid calendar days', () => {
		expect(messageTime('312359', Date.parse('2027-01-01T00:01:00Z'), 'DDHHMM')).toBe(Date.parse('2026-12-31T23:59:00Z'));
		expect(messageTime('010001', Date.parse('2026-12-31T23:59:00Z'), 'DDHHMM')).toBe(Date.parse('2027-01-01T00:01:00Z'));
		expect(messageTime('292359', Date.parse('2028-03-01T00:01:00Z'), 'DDHHMM')).toBe(Date.parse('2028-02-29T23:59:00Z'));
		expect(messageTime('312359', Date.parse('2026-05-01T00:01:00Z'), 'DDHHMM')).toBe(Date.parse('2026-05-31T23:59:00Z'));
	});
	it.each(['000746', '322346', '092460', '091260', 'notime'])('rejects invalid DDHHMM values %s', (text) => {
		expect(messageTime(text, receivedAt, 'DDHHMM')).toBeUndefined();
	});
	it('rejects invalid receipt dates and renders Auckland daylight time via viewer timezone', () => {
		expect(messageTime('090746', NaN, 'DDHHMM')).toBeUndefined();
		expect(messageTime('090746', 1e20, 'DDHHMM')).toBeUndefined();
		const timestamp = messageTime('090746', receivedAt, 'DDHHMM');
		expect(
			new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
				timestamp,
			),
		).toBe('20:46');
		expect(timeFields('invalid', receivedAt, 'HHMMSS')).toEqual([]);
	});
});
