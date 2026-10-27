import { describe, expect, it } from 'vitest';
import { decodeRtcmFields, ecefToGeodetic } from '@/worker/decoders/rtk/rtcm-fields';
import { RtkTracker, crc24q } from '@/worker/decoders/rtk/rtcm';

function payload(fields) {
	const binary = fields.map(([value, width]) => BigInt.asUintN(width, BigInt(value)).toString(2).padStart(width, '0')).join('');
	return Uint8Array.from({ length: Math.ceil(binary.length / 8) }, (_, index) =>
		parseInt(binary.slice(index * 8, index * 8 + 8).padEnd(8, '0'), 2),
	);
}
const reference = () =>
	payload([
		[1006, 12],
		[42, 12],
		[20, 6],
		[0, 4],
		[-63781370000, 38],
		[0, 2],
		[0, 38],
		[0, 2],
		[0, 38],
		[12345, 16],
	]);

describe('RTCM correction metadata', () => {
	it('reads signed 38-bit ECEF coordinates and 1006 antenna height', () => {
		const result = decodeRtcmFields(reference()).reference;
		expect(result).toMatchObject({ stationId: 42, itrf: 20, ecef: [-6378137, 0, 0] });
		expect(result.antennaHeightM).toBeCloseTo(1.2345, 4);
		expect(result.latitude).toBeCloseTo(0, 7);
		expect(Math.abs(result.longitude)).toBeCloseTo(180, 7);
		expect(result.heightM).toBeCloseTo(0, 4);
		expect(ecefToGeodetic(0, 0, 6356752.314245)).toMatchObject({ latitude: 90, longitude: 0 });
		expect(ecefToGeodetic(0, 0, 0)).toBeUndefined();
	});

	it('reads satellite and signal masks, cell counts and C/N0 from MSM4', () => {
		const fields = [
			[1074, 12],
			[42, 12],
			[123456, 30],
			[0, 1],
			[0, 18],
		];
		for (let id = 1; id <= 64; id++) fields.push([[1, 3, 32].includes(id) ? 1 : 0, 1]);
		for (let id = 1; id <= 32; id++) fields.push([[2, 8].includes(id) ? 1 : 0, 1]);
		fields.push([0b100110, 6], [0, 3 * 18], [0, 3 * 42], [35, 6], [42, 6], [48, 6]);
		const result = decodeRtcmFields(payload(fields)).observation;
		expect(result).toMatchObject({
			type: 1074,
			stationId: 42,
			constellation: 'GPS',
			epochMs: 123456,
			satellites: [1, 3, 32],
			signals: [2, 8],
			cells: 3,
			cnrDbHz: [35, 42, 48],
			measurements: [
				{ satellite: 1, signal: 2, cnrDbHz: 35, band: 'L1', group: 'primary' },
				{ satellite: 3, signal: 8, cnrDbHz: 42, band: 'L2', group: 'secondary' },
				{ satellite: 32, signal: 2, cnrDbHz: 48, band: 'L1', group: 'primary' },
			],
		});
		expect(decodeRtcmFields(payload(fields).slice(0, 24))).toEqual({});
	});

	it('reads bounded receiver descriptors and refuses truncated messages', () => {
		const fields = [
			[1033, 12],
			[42, 12],
		];
		const text = (value) => {
			fields.push([value.length, 8], ...Array.from(value, (character) => [character.charCodeAt(0), 8]));
		};
		text('ANT');
		fields.push([7, 8]);
		text('A1');
		text('GNSS');
		text('1.2');
		text('R1');
		expect(decodeRtcmFields(payload(fields)).equipment).toEqual({
			stationId: 42,
			antenna: 'ANT',
			setupId: 7,
			antennaSerial: 'A1',
			receiver: 'GNSS',
			firmware: '1.2',
			receiverSerial: 'R1',
		});
		const body = payload(fields);
		const header = Uint8Array.from([0xd3, body.length >> 8, body.length & 255, ...body]);
		const crc = crc24q(header);
		const frame = Uint8Array.from([...header, crc >> 16, (crc >> 8) & 255, crc & 255]);
		const tracker = new RtkTracker();
		tracker.process({
			data: Uint8Array.from([0x2c, 9, 0, 0, 5, 0, 123, frame.length, ...frame.map((value) => value ^ 0x12)]),
			verified: true,
			cfoHz: 0,
		});
		expect(tracker.snapshot()[0]).toMatchObject({ name: 'GNSS', scan: 123, channel: 9, netId: 5, rtcmCount: 1 });
		expect(tracker.snapshot()[0].lastCorrection).toBeGreaterThan(0);
		expect(decodeRtcmFields(reference().slice(0, 18))).toEqual({});
		expect(decodeRtcmFields(new Uint8Array())).toEqual({});
	});

	it('publishes position only after RTCM CRC verification and keeps snapshots independent', () => {
		const body = reference();
		const header = Uint8Array.from([0xd3, body.length >> 8, body.length & 255, ...body]);
		const crc = crc24q(header);
		const frame = Uint8Array.from([...header, crc >> 16, (crc >> 8) & 255, crc & 255]);
		const radio = () => ({
			data: Uint8Array.from([0x2c, 7, 0, 0, 42, 4, 0xd2, frame.length, ...frame.map((value) => value ^ 0x12)]),
			verified: true,
			cfoHz: 0,
		});
		const tracker = new RtkTracker();
		frame[7] ^= 1;
		tracker.process(radio());
		expect(tracker.snapshot()[0].reference).toBeUndefined();
		expect(tracker.snapshot()[0].lastCorrection).toBeUndefined();
		frame[7] ^= 1;
		tracker.process(radio());
		expect(tracker.snapshot()[0].reference.stationId).toBe(42);
		tracker.snapshot()[0].reference.ecef[0] = 0;
		expect(tracker.snapshot()[0].reference.ecef[0]).toBe(-6378137);
	});
});
