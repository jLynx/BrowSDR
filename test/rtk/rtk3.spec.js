import { afterEach, describe, expect, it, vi } from 'vitest';
import { crc16Modbus, decodeRtk3Frame } from '@/worker/decoders/rtk/rtk3/frame';
import { Rtk3Tracker } from '@/worker/decoders/rtk/rtk3/tracker';
import { Rtk3Containers } from '@/worker/decoders/rtk/rtk3/containers';
import { crc24q } from '@/worker/decoders/rtk/rtcm';
import { mockRtk3Packet, mockRtk3Beacon, mockRtk3Container, mockRtcmReference } from '../fixtures/rtk/mock-rtk3';

afterEach(() => vi.restoreAllMocks());

describe('RTK3 / RBS03 frame integrity', () => {
	it('uses standard CRC16/MODBUS and validates the address as part of the checksum', () => {
		expect(crc16Modbus(new TextEncoder().encode('123456789'))).toBe(0x4b37);
		const packet = mockRtk3Packet(mockRtk3Container());
		expect(decodeRtk3Frame(packet)).toMatchObject({ address: 4242 });
		packet.data[2] ^= 1;
		expect(decodeRtk3Frame(packet)).toBeUndefined();
		expect(new Rtk3Tracker().snapshot()).toEqual([]);
	});

	it('rejects unchecked, parity-damaged, wrong-PHY, overlength and malformed frames', () => {
		const packet = mockRtk3Packet(mockRtk3Container());
		const tracker = new Rtk3Tracker();
		const bad = { ...packet, data: packet.data.slice() };
		bad.data[10] ^= 1;
		for (const value of [
			bad,
			{ ...packet, codingErrors: 1 },
			{ ...packet, hasCrc: true },
			{ ...packet, codingRate: 2 },
			mockRtk3Packet(new Uint8Array(226)),
			mockRtk3Packet(new Uint8Array()),
		])
			tracker.process(value);
		expect(tracker.counters.packets).toBe(0);
		expect(tracker.flush()).toEqual([]);
		expect(tracker.snapshot()).toEqual([]);
	});

	it('recognises only complete checksummed 21-byte beacons', () => {
		const beacon = mockRtk3Beacon();
		expect(decodeRtk3Frame(beacon)).toMatchObject({ address: 4242, beaconMs: 15000 });
		const badBody = beacon.data.slice(4, -2);
		badBody[13] = 0;
		expect(decodeRtk3Frame(mockRtk3Packet(badBody))).toBeUndefined();
		beacon.data[10] ^= 1;
		expect(decodeRtk3Frame(beacon)).toBeUndefined();
	});
});

describe('RTK3 container streams', () => {
	it('invalidates pending observations before delivering corrections after loss or corruption', () => {
		const stream = new Rtk3Containers();
		const events = [];
		const receive = (body) =>
			stream.process(
				body,
				(container) => events.push(container.sequence),
				() => events.push('gap'),
			);
		receive(mockRtk3Container(undefined, 1));
		receive(mockRtk3Container(undefined, 3));
		const bad = mockRtcmReference();
		bad[5] ^= 1;
		receive(Uint8Array.from([...mockRtk3Container(bad, 4), ...mockRtk3Container(undefined, 5)]));
		expect(events).toEqual([1, 'gap', 3, 'gap', 'gap', 5]);
	});

	it.each([600, 1023])('reassembles a %i-byte RTCM payload across radio frames and interleaved beacons', (length) => {
		// Invented, unknown RTCM type 4090 exercises large and maximum-length containers.
		const bytes = new Uint8Array(length + 3);
		bytes.set([0xd3, length >> 8, length & 255, 0xff, 0xa0, 42]);
		const crc = crc24q(bytes);
		const rtcm = Uint8Array.from([...bytes, crc >> 16, (crc >> 8) & 255, crc & 255]);
		const container = mockRtk3Container(rtcm);
		const tracker = new Rtk3Tracker();
		const cuts = [0, 3, 170];
		while (cuts.at(-1) < container.length) cuts.push(Math.min(cuts.at(-1) + 225, container.length));
		for (let i = 0; i < cuts.length - 1; i++) {
			tracker.process(mockRtk3Packet(container.slice(cuts[i], cuts[i + 1])));
			tracker.process(mockRtk3Beacon());
		}
		expect(tracker.flush()).toEqual([{ type: 4090, stationId: 42, source: 'rtk3-4242', data: rtcm }]);
		expect(tracker.counters).toMatchObject({ packets: 2 * (cuts.length - 1), beacons: cuts.length - 1, containers: 1, containerErrors: 0 });
	});

	it('isolates alternating addresses with identical RTCM station IDs and decodes reference fields', () => {
		const tracker = new Rtk3Tracker();
		const a = mockRtk3Container(),
			b = mockRtk3Container(mockRtcmReference([0, 63781370000, 0]));
		for (const [body, address] of [
			[a.slice(0, 18), 4242],
			[b.slice(0, 18), 4243],
			[a.slice(18), 4242],
			[b.slice(18), 4243],
		])
			tracker.process(mockRtk3Packet(body, address));
		expect(tracker.snapshot()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ address: 4242, reference: expect.objectContaining({ stationId: 42, latitude: 0, longitude: 0 }) }),
				expect.objectContaining({ address: 4243, reference: expect.objectContaining({ stationId: 42, latitude: 0, longitude: 90 }) }),
			]),
		);
		expect(tracker.flush().map((frame) => frame.source)).toEqual(['rtk3-4242', 'rtk3-4243']);
	});

	it('rejects corrupt inner CRC and a container length differing from the RTCM length, then resynchronises', () => {
		const frame = mockRtcmReference();
		frame[5] ^= 1;
		const tracker = new Rtk3Tracker();
		tracker.process(mockRtk3Packet(mockRtk3Container(frame)));
		tracker.process(mockRtk3Packet(mockRtk3Container(Uint8Array.from([...mockRtcmReference(), 0]), 101)));
		expect(tracker.flush()).toEqual([]);
		expect(tracker.snapshot()[0].rtcmCount).toBe(0);
		tracker.process(mockRtk3Packet(mockRtk3Container(undefined, 102)));
		expect(tracker.flush()).toHaveLength(1);
		expect(tracker.counters.containerErrors).toBe(2);
	});

	it('skips non-RTCM containers, false magic and impossible lengths without exporting nested RTCM', () => {
		const tracker = new Rtk3Tracker();
		const unknown = mockRtk3Container(mockRtcmReference(), 99, 0);
		const invalid = Uint8Array.from([0xa5, 0x5a, 4, 1, 4, 1, 255, 255, 0, 0]);
		tracker.process(mockRtk3Packet(Uint8Array.from([...unknown, ...invalid, ...mockRtk3Container()])));
		expect(tracker.flush()).toHaveLength(1);
		expect(tracker.counters.containers).toBe(2);
	});

	it('counts per-base sequence increments and handles duplicates and uint16 wrap', () => {
		const tracker = new Rtk3Tracker();
		for (const sequence of [65535, 0, 0, 3]) tracker.process(mockRtk3Packet(mockRtk3Container(undefined, sequence)));
		tracker.process(mockRtk3Packet(mockRtk3Container(undefined, 100), 4243));
		expect(tracker.counters.sequenceGaps).toBe(2);
		expect(tracker.flush()).toHaveLength(4);
	});

	it('clears fragments after invalid radio data, IQ discontinuity, silence or a beacon uptime reset', () => {
		const container = mockRtk3Container();
		let now = 20000;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		for (const interrupt of [
			(tracker) => {
				const bad = mockRtk3Packet(container);
				bad.data[2] ^= 1;
				tracker.process(bad);
			},
			(tracker) => tracker.discontinuity(),
			() => {
				now += 15000;
			},
			(tracker) => {
				tracker.process(mockRtk3Beacon(4242, 15000));
				tracker.process(mockRtk3Beacon(4242, 1));
			},
		]) {
			const tracker = new Rtk3Tracker();
			tracker.process(mockRtk3Packet(container.slice(0, 18)));
			interrupt(tracker);
			tracker.process(mockRtk3Packet(container.slice(18)));
			expect(tracker.flush()).toEqual([]);
			tracker.process(mockRtk3Packet(container));
			expect(tracker.flush()).toHaveLength(1);
		}
	});

	it('evicts incomplete fragments together with old addresses and bounds pending exports', () => {
		const tracker = new Rtk3Tracker();
		const container = mockRtk3Container();
		for (let address = 1; address <= 17; address++) tracker.process(mockRtk3Packet(container.slice(0, 18), address));
		expect(tracker.snapshot()).toHaveLength(16);
		expect(tracker.snapshot().some((station) => station.address === 1)).toBe(false);
		tracker.process(mockRtk3Packet(container.slice(18), 1));
		expect(tracker.flush()).toEqual([]);
		for (let sequence = 0; sequence < 70; sequence++) tracker.process(mockRtk3Packet(mockRtk3Container(undefined, sequence)));
		expect(tracker.flush()).toHaveLength(64);
	});
});
