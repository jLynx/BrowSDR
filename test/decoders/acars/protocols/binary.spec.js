import { describe, expect, it } from 'vitest';
import { interpretAcars } from '@/app/decoders/acars/interpret';
import { interpretArinc } from '@jlynx_/acars-decoder';
import { decodeAdsc } from '@jlynx_/acars-decoder';
import { decodeCpdlc } from '@jlynx_/acars-decoder';
import { hexBytes } from '@jlynx_/acars-decoder/formats';
import adscFixtures from './adsc-fixtures.json';
import cpdlcFixtures from './cpdlc-fixtures.json';

const field = (result, label) => result.fields.find((item) => item.label === label)?.value;
const record = (text, direction = 'downlink', label = 'H1') => ({
	id: 1,
	receivedAt: Date.parse('2026-10-09T08:00:00Z'),
	registration: 'NZ7013',
	mode: '2',
	acknowledgement: 'NAK',
	label,
	blockId: '1',
	direction,
	text,
	continuation: false,
});

describe('combined ACARS binary payload decoders', () => {
	it.each(adscFixtures.filter((fixture) => fixture.name !== 'libacars_adsc_2'))('decodes reference ADS-C $name tag $tag', ({ text }) => {
		const result = interpretArinc(text);
		expect(field(result, 'Application CRC')).toContain('Verified');
		expect(result.coverage).toBe('decoded');
		expect(field(result, 'Payload parser')).toContain('ADS-C');
	});
	it('rejects the upstream sample whose inner CRC fails', () => {
		const result = interpretArinc(adscFixtures.find((fixture) => fixture.name === 'libacars_adsc_2').text);
		expect(field(result, 'Application CRC')).toBe('A1C4 · Failed');
		expect(field(result, 'Latitude')).toBeUndefined();
	});
	it('distinguishes ground speed and Mach in an independent reference sample', () => {
		const result = interpretArinc('/MGQCAYA.ADS.A6-BLJ0707E9392157890809021F0E0B30E940040F0CD9A280046DD7');
		expect(field(result, 'Ground speed')).toBe('466.5 kt');
		expect(field(result, 'Mach')).toBe('0.837');
		expect(field(result, 'True track')).toBe('31.464844°');
		expect(field(result, 'True heading')).toBe('36.123047°');
		expect(field(result, 'Air vertical rate')).toBe('16 ft/min');
	});
	it.each([
		['/UPGCAYA.ADS.B-324P07020BCD0D010E0110014BAA', '896 seconds'],
		['/OAKODYA.ADS.N509DT07030B970C000D010E0110000F01150001B64C', '192 seconds'],
		['/ANCATYA.ADS.N704GT07000BC80C000D010E0110000F011500010801140A288520', '576 seconds'],
	])('decodes uplink periodic contract %s', (text, interval) => {
		const result = interpretArinc(text, 'uplink');
		expect(result.coverage).toBe('decoded');
		expect(field(result, 'Reporting interval')).toBe(interval);
	});
	it('decodes the user NZ7013 surveillance contract through H1 wrapping', () => {
		const result = interpretAcars(
			record('- #MD/A6 AKLCDYA.ADS.NZ701307000BCD0C000D010E0110010F01150001080112B2131AA91A13140A28E844', 'uplink'),
		);
		expect(result.coverage).toBe('decoded');
		expect(field(result, 'Periodic contract')).toBe('0');
		expect(field(result, 'Reporting interval')).toBe('896 seconds');
		expect(field(result, 'Event contract')).toBe('1');
		expect(field(result, 'Altitude range')).toBe('Ceiling 27300 ft · floor 26700 ft');
	});
	it('rejects damaged inner CRC while retaining the envelope', () => {
		const result = interpretArinc(adscFixtures[0].text.slice(0, -4) + '0000');
		expect(result.coverage).toBe('partial');
		expect(field(result, 'Application CRC')).toContain('Failed');
		expect(field(result, 'Latitude')).toBeUndefined();
	});
	it('rejects truncated tags and invalid coordinates', () => {
		expect(() => decodeAdsc(hexBytes('0701'), 'downlink')).toThrow();
		expect(() => decodeAdsc(hexBytes('077FFFF8000000000000'), 'downlink')).toThrow();
	});
	it('retains interval-less contract fields as partial without inventing an interval', () => {
		const result = decodeAdsc(hexBytes('07010D01'), 'uplink');
		expect(result.complete).toBe(false);
		expect(field(result, 'Periodic contract')).toBe('1');
		expect(field(result, 'Requested Predicted route')).toBe('Reporting modulus 1');
		expect(field(result, 'Reporting interval')).toBeUndefined();
		expect(result.notes.join(' ')).toContain('no reporting interval');
	});
	it('retains decoded tags before unsupported data, without inventing a length', () => {
		const result = decodeAdsc(hexBytes('0301FF00'), 'downlink');
		expect(result.complete).toBe(false);
		expect(result.notes.join(' ')).toContain('tag 255');
	});
	it.each(cpdlcFixtures.filter((fixture) => fixture.link_direction))('identifies reference CPDLC $expected_element', (fixture) => {
		const result = interpretAcars(record(fixture.text, fixture.link_direction, fixture.label));
		expect(field(result, 'Application CRC')).toContain('Verified');
		expect(field(result, 'CPDLC instruction 1')).toBeTruthy();
		expect(field(result, 'Payload parser')).toContain('CPDLC');
	});
	it('decodes the user connection request into a readable phrase', () => {
		const result = interpretAcars(record('- #MD/AA AKLCDYA.CR1.NZ7013209F14E8E75AB53C06BF', 'uplink'));
		expect(result.coverage).toBe('decoded');
		expect(field(result, 'CPDLC instruction 1')).toBeTruthy();
	});
	it('rejects empty CPDLC data', () => expect(() => decodeCpdlc(new Uint8Array(), 'downlink')).toThrow());
	it('isolates cached results from UI mutation and respects message direction', () => {
		const text = adscFixtures[0].text;
		interpretArinc(text).fields[0].value = 'mutated';
		expect(interpretArinc(text).fields[0].value).not.toBe('mutated');
		expect(field(interpretArinc(text, 'uplink'), 'Latitude')).toBeUndefined();
	});
});
