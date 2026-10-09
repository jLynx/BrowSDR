import { describe, expect, it } from 'vitest';
import { AisHdlc, aisCrc } from '@/worker/decoders/ais/hdlc';
import { AisDemodulator } from '@/worker/decoders/ais/demodulator';
import { decodeAis } from '@/worker/decoders/ais/messages';
import { VesselTracker } from '@/worker/decoders/ais/tracker';
import { positionReport, radioSignal, report, wireBits } from './fixtures';

describe('AIS radio frames and vessel reports', () => {
	it('decodes the independently documented GPSD Class A example', () => {
		// https://gpsd.gitlab.io/gpsd/AIVDM.html, example AIVDM payload (28 six-bit characters).
		const payload = '177KQJ5000G?tO`K>RA1wUbN0TKH';
		const bytes = new Uint8Array(21);
		for (let index = 0; index < payload.length; index++) {
			let value = payload.charCodeAt(index) - 48;
			if (value > 40) value -= 8;
			for (let bit = 0; bit < 6; bit++) {
				const position = index * 6 + bit;
				bytes[position >> 3] |= ((value >> (5 - bit)) & 1) << (7 - (position & 7));
			}
		}
		expect(decodeAis(bytes)).toMatchObject({ mmsi: '477553000', navigationStatus: 5, speed: 0 });
		expect(decodeAis(bytes)?.latitude).toBeCloseTo(47.582833, 5);
		expect(decodeAis(bytes)?.longitude).toBeCloseTo(-122.345833, 5);
	});
	it('matches the published CRC-16/X-25 check vector and rejects corrupt frames', () => {
		expect(aisCrc(new TextEncoder().encode('123456789'))).toBe(0x906e);
		const frames = [];
		const decoder = new AisHdlc((frame) => frames.push(frame));
		for (const bit of wireBits(positionReport(), true)) decoder.bit(bit);
		for (const bit of wireBits(positionReport())) decoder.bit(bit);
		expect(frames).toEqual([positionReport()]);
	});
	it.each([0, 0.2, 0.6])('decodes Gaussian-shaped IQ split across arbitrary chunks (phase=%s)', (phase) => {
		const frames = [];
		const decoder = new AisDemodulator((frame) => frames.push(frame));
		const iq = radioSignal(positionReport(), 48000, 300, 0.1, phase);
		for (let i = 0; i < iq.length; i += 146) decoder.process(iq.subarray(i, i + 146));
		expect(frames).toEqual([positionReport()]);
	});
	it('decodes Class A positions and AIS unavailable sentinels', () => {
		expect(decodeAis(positionReport())).toMatchObject({
			mmsi: '512123456',
			latitude: -36.84,
			longitude: 174.76,
			speed: 12.3,
			course: 271.2,
			heading: 270,
			navigationStatus: 5,
		});
		const unavailable = report();
		unavailable.set(61, 28, 181 * 600000);
		unavailable.set(89, 27, 91 * 600000);
		unavailable.set(50, 10, 1023);
		unavailable.set(116, 12, 3600);
		unavailable.set(128, 9, 511);
		expect(decodeAis(unavailable.bytes)).toMatchObject({
			latitude: undefined,
			longitude: undefined,
			speed: undefined,
			course: undefined,
			heading: undefined,
		});
		expect(decodeAis(positionReport().slice(0, 19))).toBeUndefined();
	});
	it('merges static voyage details with later positions, clears invalid position and bounds stale vessels', () => {
		const tracker = new VesselTracker();
		const staticReport = report(5, 512123456, 53);
		staticReport.text(70, 'ZMT123', 7);
		staticReport.text(112, 'TEST VESSEL', 20);
		staticReport.text(302, 'AUCKLAND', 20);
		staticReport.set(294, 8, 45);
		tracker.process(staticReport.bytes, 1000);
		tracker.process(positionReport(), 2000);
		expect(tracker.snapshot(2000)[0]).toMatchObject({
			name: 'TEST VESSEL',
			callsign: 'ZMT123',
			destination: 'AUCKLAND',
			draught: 4.5,
			latitude: -36.84,
			messages: 2,
		});
		const invalid = report();
		invalid.set(61, 28, 181 * 600000);
		invalid.set(89, 27, 91 * 600000);
		tracker.process(invalid.bytes, 3000);
		expect(tracker.snapshot(3000)[0]).toMatchObject({ latitude: undefined, longitude: undefined, positionTime: 3000 });
		expect(tracker.snapshot(603001)).toEqual([]);
	});
	it('decodes Class B position and both static report parts', () => {
		const tracker = new VesselTracker();
		const a = report(24, 512123456, 21);
		a.text(40, 'CLASS B', 20);
		const b = report(24);
		b.set(38, 2, 1);
		b.set(40, 8, 37);
		b.text(90, 'ZMB', 7);
		const p = report(18);
		p.set(46, 10, 34);
		p.set(57, 28, 174 * 600000);
		p.set(85, 27, -36 * 600000);
		tracker.process(a.bytes);
		tracker.process(b.bytes);
		tracker.process(p.bytes);
		expect(tracker.snapshot()[0]).toMatchObject({
			name: 'CLASS B',
			callsign: 'ZMB',
			shipType: 37,
			speed: 3.4,
			latitude: -36,
			longitude: 174,
		});
	});
	it('decodes extended Class B and long-range reports with their distinct coordinate scales', () => {
		const extended = report(19, 512123456, 39);
		extended.set(57, 28, Math.round(174.76 * 600000));
		extended.set(85, 27, Math.round(-36.84 * 600000));
		extended.text(143, 'EXTENDED CLASS B', 20);
		extended.set(263, 8, 70);
		expect(decodeAis(extended.bytes)).toMatchObject({ name: 'EXTENDED CLASS B', shipType: 70, latitude: -36.84, longitude: 174.76 });
		const longRange = report(27, 512123456, 12);
		longRange.set(40, 4, 5);
		longRange.set(44, 18, Math.round(174.76 * 600));
		longRange.set(62, 17, Math.round(-36.84 * 600));
		longRange.set(79, 6, 12);
		longRange.set(85, 9, 270);
		expect(decodeAis(longRange.bytes)).toMatchObject({ navigationStatus: 5, latitude: -36.84, longitude: 174.76, speed: 12, course: 270 });
	});
});
