import { describe, expect, it } from 'vitest';
import { decodeRs41, rs41Crc } from '@/worker/decoders/radiosonde/rs41';
import { Rs41Framer } from '@/worker/decoders/radiosonde/framing';
import { RadiosondeDemodulator } from '@/worker/decoders/radiosonde/demodulator';
import { SondeTracker } from '@/worker/decoders/radiosonde/tracker';
import { frame, bits, signal } from './fixtures';

describe('RS41 telemetry', () => {
	it.each([
		[Date.UTC(2014, 6, 17, 9, 51, 57), 16],
		[Date.UTC(2015, 7, 2, 10, 39, 9), 17],
		[Date.UTC(2026, 9, 13, 0, 0, 0), 18],
	])('converts GPS weeks to UTC using the recording date (%s)', (utc, leapSeconds) => {
		const bytes = frame();
		const elapsed = utc + leapSeconds * 1000 - Date.UTC(1980, 0, 6);
		const payload = bytes.subarray(149, 179);
		const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
		view.setUint16(0, Math.floor(elapsed / 604800000), true);
		view.setUint32(2, elapsed % 604800000, true);
		const crc = rs41Crc(payload);
		bytes[179] = crc & 255;
		bytes[180] = crc >> 8;
		expect(decodeRs41(bytes).gpsTime).toBe(utc);
	});
	it('decodes newer combined GNSS position and UTC blocks', () => {
		const bytes = frame(42, true);
		const payload = new Uint8Array(38);
		payload.set(bytes.subarray(276, 294));
		const view = new DataView(payload.buffer);
		view.setUint16(18, 2026, true);
		payload.set([10, 13, 0, 2, 3, 45], 20);
		bytes[274] = 0x82;
		bytes[275] = 38;
		bytes.set(payload, 276);
		const crc = rs41Crc(payload);
		bytes[314] = crc & 255;
		bytes[315] = crc >> 8;
		const result = decodeRs41(bytes);
		expect(result.latitude).toBeCloseTo(-36.85, 5);
		expect(result.gpsTime).toBe(Date.UTC(2026, 9, 13, 0, 2, 3, 450));
		expect(result.satellites).toBeUndefined();
	});
	it('promotes a better duplicate clock-phase GPS fix without counting a second frame', () => {
		const tracker = new SondeTracker();
		const badGps = frame();
		badGps[280] ^= 1;
		tracker.process(badGps, 403, 1000);
		tracker.process(frame(), 403, 1001);
		expect(tracker.snapshot(1001)[0]).toMatchObject({ positionTime: 1001, messages: 1 });
		expect(tracker.frames).toBe(1);
	});
	it('decodes independently checked identity and ECEF position / movement', () => {
		const result = decodeRs41(frame());
		expect(result).toMatchObject({ id: 'V1234567', frame: 42, model: 'RS41', battery: 2.9, satellites: 10 });
		expect(result.latitude).toBeCloseTo(-36.85, 5);
		expect(result.longitude).toBeCloseTo(174.76, 5);
		expect(result.altitude).toBeCloseTo(12345, 1);
		expect(result.speed).toBeGreaterThan(0);
		expect(result.climb).toBeGreaterThan(0);
	});
	it('rejects damaged identities, omits damaged GPS and preserves earlier fix age', () => {
		const bad = frame();
		bad[65] ^= 1;
		expect(decodeRs41(bad)).toBeNull();
		const tracker = new SondeTracker();
		tracker.process(frame(), 403, 1000);
		const next = frame(43);
		next[280] ^= 1;
		expect(decodeRs41(next).latitude).toBeUndefined();
		tracker.process(next, 403, 2000);
		expect(tracker.snapshot(2000)[0]).toMatchObject({ positionTime: 1000, lastSeen: 2000, messages: 2 });
		expect(tracker.snapshot(2000000)).toEqual([]);
	});
	it.each([false, true])('frames standard and extended packets of either polarity (%s)', (inverted) => {
		for (const extended of [false, true]) {
			const received = [];
			const framer = new Rs41Framer((value) => received.push(value));
			bits(frame(42, extended), inverted).forEach((bit) => framer.bit(bit));
			expect(received).toEqual([frame(42, extended)]);
		}
	});
	it.each([false, true])('decodes FSK across irregular IQ buffer boundaries (%s)', (inverted) => {
		const tracker = new SondeTracker();
		const decoder = new RadiosondeDemodulator(
			(value) => tracker.process(value, 403, 1000),
			() => {},
		);
		const iq = signal(frame(), 48000, 700, inverted);
		for (let index = 0; index < iq.length; index += 222) decoder.process(iq.subarray(index, index + 222));
		expect(tracker.frames).toBe(1);
		expect(tracker.snapshot(1000)[0].id).toBe('V1234567');
	});
	it('discards a partial frame across a reception gap', () => {
		const received = [];
		const decoder = new RadiosondeDemodulator(
			(value) => received.push(value),
			() => {},
		);
		const iq = signal(frame());
		decoder.process(iq.subarray(0, 10000));
		decoder.reset();
		decoder.process(iq.subarray(10000));
		expect(received).toEqual([]);
	});
});
