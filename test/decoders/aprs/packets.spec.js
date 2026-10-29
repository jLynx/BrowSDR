import { describe, expect, it } from 'vitest';
import { decodeInfo, decodePacket, telemetryDefinition } from '@/worker/decoders/aprs/packets';
import { decodeAx25 } from '@/worker/decoders/aprs/ax25';
import { ax25Frame } from './fixtures';

const info = (text, destination = 'APRS') => decodeInfo(text, destination);
const utf8 = (text) => String.fromCharCode(...new TextEncoder().encode(text));
const nmea = (body) => {
	let sum = 0;
	for (const char of body) sum ^= char.charCodeAt(0);
	return `$${body}*${sum.toString(16).toUpperCase().padStart(2, '0')}`;
};

// Examples from the APRS Protocol Reference 1.0.1 unless noted.
describe('APRS positions', () => {
	it('decodes uncompressed positions, messaging capability, timestamps and comments', () => {
		const plain = info('!4903.50N/07201.75W-Test 001234');
		expect(plain).toMatchObject({ kind: 'position', format: 'uncompressed', messaging: false, symbol: '/-', comment: 'Test 001234' });
		expect(plain.latitude).toBeCloseTo(49.058333, 6);
		expect(plain.longitude).toBeCloseTo(-72.029167, 6);
		expect(info('=4903.50N/07201.75W-').messaging).toBe(true);
		expect(info('/092345z4903.50N/07201.75W>Test1234')).toMatchObject({ timestamp: '092345z', symbol: '/>', comment: 'Test1234' });
		expect(info('4903.50S\\07201.75E>')).toMatchObject({ kind: 'other' });
		const south = info('!4903.50S\\07201.75E>');
		expect([south.latitude < 0, south.longitude > 0, south.symbol]).toEqual([true, true, '\\>']);
	});
	it('decodes course, speed, altitude, PHG and range extensions', () => {
		const moving = info('@092345/4903.50N/07201.75W>088/036');
		expect(moving).toMatchObject({ messaging: true, course: 88 });
		expect(moving.speed).toBeCloseTo(36 * 1.852, 6);
		expect(info('!4903.50N/07201.75W>000/000').course).toBeUndefined();
		const high = info('!4903.50N/07201.75W-Test /A=001234');
		expect(high.altitude).toBeCloseTo(376.1232, 4);
		expect(high.comment).toBe('Test');
		expect(info('!4903.50N/07201.75W#PHG5132').phg).toEqual({ power: 25, height: 20 * 0.3048, gain: 3, directivity: 90 });
		expect(info('!4903.50N/07201.75W#RNG0050').range).toBeCloseTo(80.4672, 4);
	});
	it('centers ambiguous positions inside the withheld area', () => {
		const one = info('!4903.5 N/07201.75W-');
		expect(one.ambiguity).toBe(1);
		expect(one.latitude).toBeCloseTo(49 + 3.55 / 60, 6);
		expect(one.longitude).toBeCloseTo(-(72 + 1.75 / 60), 6);
		expect(info('!49  .  N/072  .  W-')).toMatchObject({ ambiguity: 4, latitude: 49.5, longitude: -72.5 });
		expect(info('!49 3.50N/07201.75W-').kind).toBe('other');
	});
	it('decodes compressed positions with course/speed, altitude, range and overlays', () => {
		const moving = info('=/5L!!<*e7>7P[');
		expect(moving).toMatchObject({ format: 'compressed', messaging: true, symbol: '/>', course: 88 });
		expect(moving.latitude).toBeCloseTo(49.5, 5);
		expect(moving.longitude).toBeCloseTo(-72.75, 5);
		expect(moving.speed / 1.852).toBeCloseTo(1.08 ** 47 - 1, 6);
		expect(Math.floor(info('!/5L!!<*e7OS]S').altitude / 0.3048)).toBe(10004);
		expect(info('!/5L!!<*e7>{?!').range / 1.609344).toBeCloseTo(2 * 1.08 ** 30, 6);
		expect(info('!a5L!!<*e7>7P[').symbol).toBe('0>');
		expect(info('!/5L!!<*e7>  !Fixed').comment).toBe('Fixed');
	});
	it('decodes Mic-E latitude, message, longitude, motion and altitude', () => {
		// 33°25.64'N 112°07.74'W, 20 kt at 251°, In service, 100 m.
		const decoded = info('`(_f\x1e\x1eO>/"4{}Hello', 'S3RUVT');
		expect(decoded).toMatchObject({ kind: 'position', format: 'mic-e', symbol: '/>', course: 251, altitude: 100 });
		expect(decoded).toMatchObject({ micEStatus: 'In service', comment: 'Hello' });
		expect(decoded.latitude).toBeCloseTo(33 + 25.64 / 60, 6);
		expect(decoded.longitude).toBeCloseTo(-(112 + 7.74 / 60), 6);
		expect(decoded.speed).toBeCloseTo(20 * 1.852, 6);
		expect(info('`(_f\x1e\x1eO>/', 'D3CUVT').micEStatus).toBe('Custom-2');
		expect(info('`(_f\x1e\x1eO>/', 'C3RUVT').micEStatus).toBe('Unknown');
		const emergency = info('`d_f\x1c\x1c\x1c>/', '33256T');
		expect(emergency).toMatchObject({ micEStatus: 'Emergency' });
		expect(emergency.latitude).toBeCloseTo(-(33 + 25.64 / 60), 6);
		expect(emergency.longitude).toBeCloseTo(-(72 + 7.74 / 60), 6);
		expect(emergency.course).toBeUndefined();
		expect(info('`(_f\x1e\x1eO>/', 'S3RAVT').kind).toBe('other');
	});
	it('decodes checksummed NMEA and rejects corrupt sentences', () => {
		const rmc = info(nmea('GPRMC,063909,A,3349.4302,N,11700.3721,W,43.022,89.3,291099,13.6,E'));
		expect(rmc).toMatchObject({ kind: 'position', format: 'nmea', course: 89.3 });
		expect(rmc.latitude).toBeCloseTo(33 + 49.4302 / 60, 6);
		expect(rmc.longitude).toBeCloseTo(-(117 + 0.3721 / 60), 6);
		expect(rmc.speed).toBeCloseTo(43.022 * 1.852, 6);
		const gga = info(nmea('GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,'));
		expect(gga).toMatchObject({ altitude: 545.4 });
		expect(gga.longitude).toBeCloseTo(11.516667, 6);
		expect(info('$GPRMC,063909,A,3349.4302,N,11700.3721,W,43.022,89.3,291099,13.6,E*00').kind).toBe('other');
		expect(info(nmea('GPRMC,063909,V,3349.4302,N,11700.3721,W,0,0,291099,,')).kind).toBe('other');
	});
	it('decodes positions after a TNC beacon prefix and UTF-8 comments', () => {
		expect(info('TheNet X1J4 (N0CALL)!4903.50N/07201.75W-')).toMatchObject({ kind: 'position', symbol: '/-' });
		expect(info(utf8('!4903.50N/07201.75W-Zürich')).comment).toBe('Zürich');
	});
});

describe('APRS objects, messages and telemetry', () => {
	it('decodes live and killed objects and items', () => {
		expect(info(';LEADER   *092345z4903.50N/07201.75W>088/036')).toMatchObject({
			kind: 'object',
			name: 'LEADER',
			killed: false,
			timestamp: '092345z',
			course: 88,
		});
		expect(info(';LEADER   _092345z4903.50N/07201.75W>').killed).toBe(true);
		expect(info(')AID #2!4903.50N/07201.75WA')).toMatchObject({ kind: 'item', name: 'AID #2', killed: false, symbol: '/A' });
		expect(info(')G/WB4APR_4903.50N/07201.75WA')).toMatchObject({ name: 'G/WB4APR', killed: true });
	});
	it('decodes messages, acknowledgements, reply-acks and bulletins', () => {
		expect(info(':WU2Z     :Testing{003').message).toEqual({ kind: 'message', addressee: 'WU2Z', text: 'Testing', id: '003' });
		expect(info(':KB2ICI-14:ack003').message).toEqual({ kind: 'ack', addressee: 'KB2ICI-14', text: '', id: '003' });
		expect(info(':KB2ICI-14:rej003').message.kind).toBe('reject');
		expect(info(':WU2Z     :Testing{03}AB').message).toMatchObject({ text: 'Testing', id: '03' });
		expect(info(':BLN3     :Snow expected in Tampa RSN').message).toMatchObject({ kind: 'bulletin', addressee: 'BLN3' });
		expect(info(':WU2Z     :No ack requested').message).toEqual({ kind: 'message', addressee: 'WU2Z', text: 'No ack requested' });
		expect(info(':WU2Z:short').kind).toBe('other');
	});
	it('decodes status reports, telemetry and telemetry definitions', () => {
		expect(info('>Net Control Center')).toEqual({ kind: 'status', status: 'Net Control Center' });
		expect(info('>092345zNet Control Center')).toMatchObject({ timestamp: '092345z', status: 'Net Control Center' });
		expect(info('T#005,199,000,255,073,123,01101001').telemetry).toEqual({
			sequence: '005',
			analog: [199, 0, 255, 73, 123],
			digital: '01101001',
		});
		expect(info('T#MIC,1.5,-2').telemetry).toEqual({ sequence: 'MIC', analog: [1.5, -2] });
		expect(info(':N0QBF-11 :PARM.Battery,Btemp,ATemp,Pres,Alt').message).toMatchObject({
			kind: 'telemetry-definition',
			addressee: 'N0QBF-11',
		});
		expect(telemetryDefinition('PARM.Battery,Btemp,ATemp,Pres,Alt,Camra')).toEqual({
			names: ['Battery', 'Btemp', 'ATemp', 'Pres', 'Alt', 'Camra'],
		});
		expect(telemetryDefinition('EQNS.0,5.2,0,0,.53,-32,3,4.39,49,-32,3,18,1,2,3').equations).toEqual([
			[0, 5.2, 0],
			[0, 0.53, -32],
			[3, 4.39, 49],
			[-32, 3, 18],
			[1, 2, 3],
		]);
		expect(telemetryDefinition('BITS.10110000,N0QBF Balloon')).toEqual({ bits: '10110000', project: 'N0QBF Balloon' });
		expect(telemetryDefinition('EQNS.a,b,c')).toBeUndefined();
	});
	it('decodes weather in metric units with and without positions', () => {
		const positioned = info('!4903.50N/07201.75W_220/004g005t077r000p000P000h50b09900wRSW');
		expect(positioned).toMatchObject({ kind: 'weather', symbol: '/_', comment: 'wRSW' });
		expect(positioned.weather).toMatchObject({ windDirection: 220, temperature: 25, rain1h: 0, humidity: 50, pressure: 990 });
		expect(positioned.weather.windSpeed).toBeCloseTo(4 * 0.44704, 6);
		expect(positioned.weather.windGust).toBeCloseTo(5 * 0.44704, 6);
		const positionless = info('_10090556c220s004g005t-05r...h00b09900wRSW');
		expect(positionless).toMatchObject({ kind: 'weather', timestamp: '10090556', comment: 'wRSW' });
		expect(positionless.weather).toMatchObject({ windDirection: 220, humidity: 100, pressure: 990 });
		expect(positionless.weather.temperature).toBeCloseTo(((-5 - 32) * 5) / 9, 6);
		expect(positionless.weather.rain1h).toBeUndefined();
		expect(info('!/5L!!<*e7_7P[t050').weather).toMatchObject({ windDirection: 88, temperature: 10 });
	});
	it('decodes third-party traffic, capabilities, queries and unknown formats', () => {
		const relayed = decodePacket(
			decodeAx25(ax25Frame('N0IGT', 'APRS', ['WIDE2-1'], '}W1AW>APRS,TCPIP,N0CALL*:!4903.50N/07201.75W-Relayed')),
		);
		expect(relayed).toMatchObject({ source: 'W1AW', destination: 'APRS', path: ['TCPIP', 'N0CALL*'], relay: 'N0IGT', comment: 'Relayed' });
		expect(info('<IGATE,MSG_CNT=30,LOC_CNT=11')).toEqual({ kind: 'capabilities', comment: 'IGATE,MSG_CNT=30,LOC_CNT=11' });
		expect(info('?APRS?').kind).toBe('query');
		expect(info(',test')).toEqual({ kind: 'other', comment: ',test' });
		expect(decodePacket(decodeAx25(ax25Frame('N0CALL', 'APRS', [], '`\x1c')))).toMatchObject({ kind: 'other', info: '`<0x1c>' });
	});
});
