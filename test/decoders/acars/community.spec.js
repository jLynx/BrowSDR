import { describe, expect, it } from 'vitest';
import { interpretAcars } from '@/app/decoders/acars/interpret';
import { interpretCommunity } from '@jlynx_/acars-decoder/formats';
import { ACARS_LABELS, labelDescription } from '@jlynx_/acars-decoder';
import { corpus } from './community-fixtures';

const record = (label, text, extra = {}) => ({
	id: 1,
	receivedAt: Date.parse('2026-10-09T08:00:00Z'),
	registration: 'ZK-NZE',
	mode: '2',
	acknowledgement: 'NAK',
	label,
	blockId: '1',
	direction: 'downlink',
	text,
	continuation: false,
	...extra,
});

describe('documented ACARS format coverage', () => {
	it.each(corpus.filter(([source]) => source !== 'Label_4A_Slash_01.test.ts'))(
		'extracts documented fields from %s (%s)',
		(source, label, text, plugin) => {
			const message = record(label, text);
			const community = interpretCommunity(message);
			expect(community, source).toBeDefined();
			expect(community.notes.join(' ')).toContain(`(${plugin})`);
			const result = interpretAcars(message);
			expect(result.coverage).not.toBe('unknown');
			expect(result.fields.length).toBeGreaterThan(0);
			expect(result.fields.every((field) => !/NaN|Infinity/.test(field.value))).toBe(true);
			expect(message.text).toBe(text);
		},
	);
	it('leaves a matched marker with no extracted fields unparsed', () => {
		expect(interpretAcars(record('4A', '/01-C')).coverage).toBe('unknown');
	});
	it('decodes documented ground station squitters', () => {
		const result = interpretAcars(record('SQ', 'V2AA01XAJFKKJFK34075N7398WV136975/extra'));
		expect(result.title).toBe('Ground Station Squitter');
		expect(result.fields).toContainEqual({ label: 'Network', value: 'ARINC' });
		expect(result.fields.some((field) => field.value.includes('136.975'))).toBe(true);
	});
	it('extracts positions and documented units while retaining unparsed columns', () => {
		const result = interpretAcars(record('12', 'POSN 390104W 754601,-------,1244,1446,,-  4,23249  12,FOB   73,ETA 1303,KATL,KPHL,'));
		expect(result).toMatchObject({ title: 'Position Report', coverage: 'partial' });
		expect(result.fields).toEqual(
			expect.arrayContaining([
				{ label: 'Altitude', value: '14460 feet' },
				{ label: 'Origin', value: 'KATL · Hartsfield Jackson Atlanta International Airport' },
				{ label: 'Destination', value: 'KPHL · Philadelphia International Airport' },
			]),
		);
	});
	it('does not invent a calendar date for upstream time-only fields', () => {
		const result = interpretAcars(record('44', 'OFF02,N39247W077226,KFDK,KSNA,1106,2124,0248,011.1'));
		expect(result.fields).toContainEqual({ label: 'Takeoff Time', value: '21:24:00 UTC (date not supplied)' });
	});
	it('strips an H1 application envelope before decoding', () => {
		const result = interpretAcars(record('H1', '#CFBL95AQF0073/KSFO.TI2/030KSFOAFF5C'));
		expect(result.title).toBe('ATIS Subscription');
		expect(result.fields[0]).toEqual({ label: 'H1 sublabel', value: 'CF' });
	});
	it('keeps decoded cache entries independent of packet continuation and caller mutations', () => {
		const message = record('H1', 'L95AQF0073/KSFO.TI2/030KSFOAFF5C', { continuation: true });
		const first = interpretAcars(message);
		first.fields[0].value = 'mutated';
		first.notes.push('mutated');
		const next = interpretAcars({ ...message, continuation: false });
		expect(next.fields[0].value).not.toBe('mutated');
		expect(next.notes.join(' ')).not.toMatch(/mutated|ETB/);
	});
	it.each(['N 99.150,W121.187,39000,161859, 109,.C-GWSO,1742', 'N 42.150,W191.187,39000,161859, 109,.C-GWSO,1742'])(
		'rejects impossible coordinates: %s',
		(text) => {
			expect(interpretAcars(record('12', text)).coverage).toBe('unknown');
		},
	);
	it.each(['QP', 'QQ', 'QR', 'QS'])('rejects malformed %s events instead of trusting permissive upstream extraction', (label) => {
		for (const text of ['bad', 'KSFOKLAX2460', '1234KLAX0900']) expect(interpretAcars(record(label, text)).coverage).toBe('unknown');
		expect(interpretAcars(record(label, 'KSFOKLAX0900', { direction: 'uplink' })).coverage).toBe('unknown');
	});
	it('labels binary application data as partial', () => {
		expect(interpretAcars(record('B6', '/SOMECPDLCBODY')).coverage).toBe('partial');
	});
	it('keeps blank event times as missing instead of converting them to midnight', () => {
		for (const label of ['QA', 'QP']) {
			const result = interpretAcars(record(label, label === 'QA' ? 'NZAA    ' : 'NZAANZCH    '));
			expect(result.fields).toContainEqual({ label: 'Out time', value: 'Not reported' });
		}
	});
	it('preserves malformed or unsupported compressed transfers', () => {
		for (const [label, text] of [
			['MA', 'T02compressed-data'],
			['H1', 'OHMAcompressed-data'],
		]) {
			const result = interpretAcars(record(label, text));
			expect(result.coverage).not.toBe('decoded');
			expect(result.fields.some((field) => field.label === 'Application JSON')).toBe(false);
		}
	});
	it('ignores oversized and malformed application payloads', () => {
		expect(interpretCommunity(record('H1', 'L'.repeat(8193)))).toBeUndefined();
		for (const label of ['10', '12', '16', '44', 'H1', 'H2', 'SQ']) {
			for (const text of ['?', '', 'WRN/', 'N 999/W999', '<script>payload</script>'])
				expect(() => interpretAcars(record(label, text))).not.toThrow();
		}
	});
	it.each(Object.keys(ACARS_LABELS).filter((label) => !['_d', 'Q0'].includes(label)))(
		'explains %s without claiming an unknown payload was decoded',
		(label) => {
			const result = interpretAcars(record(label, 'unrecognized payload'));
			expect(result.coverage).toBe('unknown');
			expect(result.title).toBe(ACARS_LABELS[label].title);
		},
	);
	it('does not read inherited object properties as labels', () => {
		expect(labelDescription('constructor')).toBeUndefined();
		expect(labelDescription('7A').title).toBe('ACARS message (7A)');
	});
	it('extracts explicit markers across airlines without guessing measurement units or ETA timezone', () => {
		const result = interpretAcars(record('3R', 'REG ZK-ABC FLT ANZ123 DEP NZAA DEST NZCH FOB 123 UTC 0809 ETA 0915 ALT 350'));
		expect(result).toMatchObject({ title: 'Tagged aircraft report', coverage: 'partial' });
		expect(result.fields).toEqual(
			expect.arrayContaining([
				{ label: 'Fuel on board (FOB, raw)', value: '123' },
				{ label: 'Estimated arrival', value: '09:15 (timezone unspecified)' },
				{ label: 'Reported registration', value: 'ZK-ABC' },
			]),
		);
	});
	it.each([
		['Q1', 'NZAA0700071008000810    NZCH', 'Off time', '07:10'],
		['Q2', 'NZAA0809', 'ETA', '08:09'],
		['QA', 'NZAA0746', 'Out time', '07:46'],
		['QB', 'NZAA0746', 'Off time', '07:46'],
		['QC', 'NZAA0746', 'On time', '07:46'],
		['QD', 'NZAA0746', 'In time', '07:46'],
		['QE', 'NZAA0746NZCH', 'Destination', 'NZCH'],
		['QF', 'EWR2210ATL', 'Off time', '22:10'],
		['QG', 'NZAA07460810', 'In time', '08:10'],
		['QH', 'NZAA0746', 'Out time', '07:46'],
		['QK', 'NZAA0746NZCH', 'On time', '07:46'],
		['QL', 'NZCH    0810 NZAA', 'Origin', 'NZAA'],
		['QM', 'NZCH    NZAA', 'Origin', 'NZAA'],
		['QN', '    NZCH0810', 'ETA', '08:10'],
		['QT', 'NZAANZCH07460810', 'In time', '08:10'],
	])('handles documented standard %s flight events', (label, text, field, value) => {
		const result = interpretAcars(record(label, text));
		expect(result.coverage).not.toBe('unknown');
		expect(result.fields.find((item) => item.label === field)?.value).toContain(value);
	});
});
