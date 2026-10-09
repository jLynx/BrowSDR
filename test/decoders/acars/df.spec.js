import { describe, expect, it } from 'vitest';
import { interpretAcars } from '@/app/decoders/acars/interpret';
import { interpretAcarsLog } from '@/app/decoders/acars/context';

const header =
	'#DFBA380000047,1,1,TB000000;REP020,01;H0102001400000005.A6-EVQ10091026082944070;H02NZAA OMDBUAE5AM    S0586S0785RTRRV11D09;H03Normal Landing Gear Retraction                                    ;A1008292310;A20+0';
const second =
	'#DFB0000010005+00000000006;A21+00000010036+00000000038;A22+00000010005+00000000006;A23+00000010036+00000000038;A24+00000010041+00000000042;A25+00000010156+00000000158;A26+00000010169+00000000169;A27+00000010191';
const fourth =
	'#DFB35;A35+00000010149+00000000150;A36+00000010034+00000000035;A37+00000010150+00000000150;A38+00000010162+00000000162;A39+00000010188+00000000188;A40+00000010162+00000000162;A41+00000010188+00000000188;A50+000';
const record = (text, extra = {}) => ({
	id: 1,
	receivedAt: Date.parse('2026-10-09T08:32:42Z'),
	registration: 'A6-EVQ',
	mode: '2',
	acknowledgement: 'NAK',
	label: 'H1',
	blockId: '4',
	direction: 'downlink',
	messageNumber: 'U62A',
	text,
	continuation: true,
	...extra,
});
const continuation = (extra = {}) =>
	record(second, { id: 2, receivedAt: Date.parse('2026-10-09T08:32:50Z'), messageNumber: 'U62B', blockId: '5', ...extra });
const field = (result, label) => result.fields.find((item) => item.label === label)?.value;

describe('Airbus DF report content and context', () => {
	it('extracts the A380 report event and route without inventing numeric meanings', () => {
		const message = record(header);
		const result = interpretAcars(message);
		expect(result).toMatchObject({
			title: 'A380 aircraft report 020',
			coverage: 'partial',
			coverageDetail: 'Header / event text decoded · measurements undecoded',
		});
		expect(field(result, 'Reported registration')).toBe('A6-EVQ');
		expect(field(result, 'Reported flight code')).toBe('UAE5AM');
		expect(field(result, 'Departure')).toBe('NZAA · Auckland Airport');
		expect(field(result, 'Destination')).toBe('OMDB · Dubai International Airport');
		expect(field(result, 'Reported event')).toBe('Normal Landing Gear Retraction');
		expect(result.fields.some((item) => /time|pressure|speed|temperature/i.test(item.label))).toBe(false);
		expect(result.notes.join(' ')).toContain('not decoded by the Airframes library');
		expect(message.text).toBe(header);
	});
	it('generalizes semicolon headers and event text without mapping report IDs', () => {
		const result = interpretAcars(
			record(
				header
					.replace('A380000047', 'A350,000047')
					.replace('REP020', 'REP999')
					.replace('Normal Landing Gear Retraction', 'Example Equipment Event'),
			),
		);
		expect(result.title).toBe('A350 aircraft report 999');
		expect(field(result, 'Reported event')).toBe('Example Equipment Event');
	});
	it.each([header.slice(0, 28), header.replace('TB000000', 'XX000000')])('does not claim a malformed header was decoded', (text) => {
		expect(interpretAcars(record(text)).coverage).toBe('unknown');
	});
	it('does not apply a DF report header to a different application sublabel', () => {
		expect(interpretAcars(record(header.replace('#DFB', '#MDB'))).coverage).toBe('unknown');
	});
	it('labels standalone numeric fragments as undecoded rather than partially decoded', () => {
		const result = interpretAcars(continuation());
		expect(result).toMatchObject({ coverage: 'unknown', coverageDetail: 'Payload undecoded' });
		expect(field(result, 'Numeric section identifiers (raw)')).toContain('A21');
		expect(field(result, 'Reported event')).toBeUndefined();
	});
	it('shows report context for U62B and U62D with a missing U62C, preserving separate raw blocks', () => {
		const messages = [
			record(header),
			continuation(),
			record(fourth, { id: 4, receivedAt: Date.parse('2026-10-09T08:33:05Z'), messageNumber: 'U62D', blockId: '7' }),
		];
		const results = interpretAcarsLog([...messages].reverse());
		for (const result of results.slice(1)) {
			expect(result.interpretation.title).toContain('A380 aircraft report 020 · block');
			expect(result.interpretation.summary).toContain('Normal Landing Gear Retraction');
			expect(result.interpretation.coverage).toBe('unknown');
			expect(field(result.interpretation, 'Reported event (from first block)')).toBe('Normal Landing Gear Retraction');
			expect(result.interpretation.notes.join(' ')).toContain('missing intermediate blocks');
		}
		expect(results.map((result) => result.text)).toEqual(messages.map((message) => message.text));
	});
	it.each([
		{ registration: 'A6-OTHER' },
		{ messageNumber: 'U63B' },
		{ mode: '1' },
		{ direction: 'uplink' },
		{ receivedAt: Date.parse('2026-10-09T08:35:00Z') },
		{ messageNumber: undefined },
	])('does not associate incompatible or expired headers: %s', (extra) => {
		const results = interpretAcarsLog([record(header), continuation(extra)]);
		expect(results[1].interpretation.fields.some((item) => item.label.includes('from first block'))).toBe(false);
	});
	it('does not associate across separate VFO logs or a new unrecognized first block', () => {
		interpretAcarsLog([record(header)]);
		expect(interpretAcarsLog([continuation()])[0].interpretation.title).toBe('Aircraft report fragment');
		const results = interpretAcarsLog([
			record(header),
			record('#DFBunknown', { id: 2, receivedAt: Date.parse('2026-10-09T08:32:45Z') }),
			continuation({ id: 3 }),
		]);
		expect(results[2].interpretation.title).toBe('Aircraft report fragment');
	});
	it('does not associate continuations with a completed first block or conflicting flights', () => {
		for (const start of [record(header, { continuation: false }), record(header, { flight: 'UAE1' })]) {
			const results = interpretAcarsLog([start, continuation({ flight: 'UAE2' })]);
			expect(results[1].interpretation.title).toBe('Aircraft report fragment');
		}
	});
	it('tries a documented community DF payload before the generic fragment fallback', () => {
		const result = interpretAcars(
			record(
				'#DFBPOS/ID91459S,BANKR31,/DC03032024,142813/MR64,0/ET31539/PSN39277W077359,142800,240,N39300W077110,031430,N38560W077150,M28,27619,MT370/CG311,160,350/FB732/VR329071',
			),
		);
		expect(result.title).toBe('Position Report');
		expect(result.notes.join(' ')).toContain('Airframes (arinc-702)');
	});
});
