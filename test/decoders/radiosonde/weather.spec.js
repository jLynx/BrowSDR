import { describe, expect, it } from 'vitest';
import { Rs41Calibration } from '@/worker/decoders/radiosonde/calibration';
import { decodeWeather, altitudePressure } from '@/worker/decoders/radiosonde/weather';
import { SondeTracker } from '@/worker/decoders/radiosonde/tracker';
import { rs41Crc } from '@/worker/decoders/radiosonde/rs41';
import { validRadiosondeMessage } from '@/worker/decoders/radiosonde/validation';
import { decodeGnss } from '@/worker/decoders/radiosonde/gnss';
import fixture from './recorded-weather.json';
import { frame } from './fixtures';

// Calibration and sensor payload extracted from rs1729/RS's July 2014 recording.
const calibrationBytes = Uint8Array.from(Buffer.from(fixture.calibration, 'hex'));
const sensor = Uint8Array.from(Buffer.from(fixture.sensor, 'hex'));
function calibration(omit = []) {
	const cal = new Rs41Calibration();
	for (let index = 0; index < 51; index++) {
		if (omit.includes(index)) continue;
		const identity = new Uint8Array(40);
		identity[22] = 50;
		identity[23] = index;
		identity.set(calibrationBytes.subarray(index * 16, index * 16 + 16), 24);
		cal.update(identity);
	}
	return cal;
}
describe('RS41 weather and configuration', () => {
	it('decodes satellite signal/quality codes, fractional pseudorange and signed raw Doppler', () => {
		const info = new Uint8Array(30).fill(255);
		info[6] = 12;
		info[7] = 3 * 32 + 7;
		const raw = new Uint8Array(89);
		const view = new DataView(raw.buffer);
		view.setUint32(0, 21000000, true);
		view.setUint32(5, 128, true);
		raw.set([0xfe, 0xff, 0xff], 9);
		raw[4] = 0x42;
		expect(
			decodeGnss(
				new Map([
					[0x7c, info],
					[0x7d, raw],
				]),
			),
		).toMatchObject({
			gnssJamming: 4,
			gnssAgc: 2,
			gnssSatellites: [{ prn: 12, signal: 3, quality: 7, pseudorange: 21000000.5, doppler: -2 }],
		});
	});
	it('assembles checked calibration and extracts hardware, frequency and timer state', () => {
		const data = calibration().telemetry(1000);
		expect(data).toMatchObject({
			calibrationCount: 51,
			calibrationComplete: true,
			subtype: 'RS41-SG',
			mainboard: 'RSM412',
			txFrequency: 402,
			killCountdown: -1,
		});
		expect(data.configuration.find((field) => field.label === 'CPU temperature')).toBeDefined();
	});
	it('calculates temperature and humidity from actual sensor/calibration data', () => {
		const weather = decodeWeather(sensor, calibration(), fixture.altitude);
		expect(weather.temperature).toBeCloseTo(-40.673, 2);
		expect(weather.humiditySensorTemperature).toBeCloseTo(-35.557, 2);
		expect(weather.humidity).toBeCloseTo(0.376, 2);
		expect(weather.pressure).toBeUndefined(); // RS41-SG has no pressure sensor.
		expect(weather.estimatedPressure).toBeCloseTo(12.934, 2);
	});
	it('does not interpret incomplete calibration or zero reference counts as weather', () => {
		expect(decodeWeather(sensor, calibration([5]), fixture.altitude).temperature).toBeUndefined();
		expect(decodeWeather(sensor, calibration([14]), fixture.altitude).humidity).toBeUndefined();
		expect(decodeWeather(new Uint8Array(42), calibration(), fixture.altitude).temperature).toBeUndefined();
		expect(altitudePressure(0)).toBeCloseTo(1013.25, 2);
		expect(altitudePressure(11000)).toBeCloseTo(226.32, 1);
	});
	it('calibrates measured pressure independently and distinguishes it from estimated pressure', () => {
		const cal = calibration();
		const view = new DataView(cal.bytes.buffer);
		for (let index = 0; index < 18; index++) view.setFloat32(606 + index * 4, 0, true);
		view.setFloat32(606, 100, true);
		view.setFloat32(610, 2, true);
		view.setFloat32(630, 10, true);
		const bytes = sensor.slice();
		const count = (offset, value) => {
			bytes[offset] = value;
			bytes[offset + 1] = value >> 8;
			bytes[offset + 2] = value >> 16;
		};
		count(27, 150);
		count(30, 100);
		count(33, 200);
		new DataView(bytes.buffer).setInt16(38, 2500, true);
		expect(decodeWeather(bytes, cal, 10000)).toMatchObject({ pressure: 140, pressureSensorTemperature: 25 });
	});
	it('never caches a damaged calibration fragment, preserves max altitude and bounds peer data', () => {
		const tracker = new SondeTracker();
		const bytes = frame();
		bytes[81] = 50;
		bytes[82] = 0;
		bytes.set(calibrationBytes.subarray(0, 16), 83);
		const crc = rs41Crc(bytes.subarray(59, 99));
		bytes[99] = crc & 255;
		bytes[100] = crc >> 8;
		tracker.process(bytes, 403, 1000);
		const damaged = bytes.slice();
		damaged[82] = 1;
		tracker.process(damaged, 403, 2000);
		const sonde = tracker.snapshot(2000)[0];
		expect(sonde.calibrationCount).toBe(1);
		expect(sonde.maxAltitude).toBeCloseTo(12345, 1);
		const message = {
			type: 'radiosonde',
			freq: 403,
			status: { state: 'receiving', message: 'Listening', samples: 1, frames: 1, syncs: 1, crcErrors: 0 },
			sondes: [sonde],
		};
		expect(validRadiosondeMessage(message)).toBe(true);
		for (const patch of [
			{ temperature: NaN },
			{ rawBlocks: [{ type: 0x7e, data: '<script>', crcValid: true }] },
			{ calibrationFragments: Array(52).fill({ index: 0, data: '00'.repeat(16) }) },
		])
			expect(validRadiosondeMessage({ ...message, sondes: [{ ...sonde, ...patch }] })).toBe(false);
	});
	it('clears invalid new sensor readings instead of presenting older weather as current', () => {
		const tracker = new SondeTracker();
		const checksum = (bytes, start, end) => {
			const crc = rs41Crc(bytes.subarray(start, end));
			bytes[end] = crc & 255;
			bytes[end + 1] = crc >> 8;
		};
		for (let index = 0; index < 51; index++) {
			const bytes = frame(index);
			bytes[81] = 50;
			bytes[82] = index;
			bytes.set(calibrationBytes.subarray(index * 16, index * 16 + 16), 83);
			checksum(bytes, 59, 99);
			bytes.set(sensor, 103);
			checksum(bytes, 103, 145);
			tracker.process(bytes, 403, 1000 + index * 1000);
		}
		expect(tracker.snapshot(51000)[0].temperature).toBeDefined();
		tracker.process(frame(51), 403, 52000);
		expect(tracker.snapshot(52000)[0].temperature).toBeUndefined();
		expect(tracker.snapshot(52000)[0].weatherTime).toBeUndefined();
	});
});
