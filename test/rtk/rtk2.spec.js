import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeRtk2Bytes } from '@/worker/decoders/rtk/rtk2/transform';
import { crc8Maxim, decodeRtk2Frame } from '@/worker/decoders/rtk/rtk2/frame';
import { Rtk2Tracker } from '@/worker/decoders/rtk/rtk2/tracker';
import { crc24q } from '@/worker/decoders/rtk/rtcm-frame';
import { mockRtk2Packet, mockRtk2Plain, mockRtk2Wire, mockRtk2Checks } from '../fixtures/rtk/mock-rtk2';
import { mockRtcmReference } from '../fixtures/rtk/mock-rtk3';

afterEach(() => vi.restoreAllMocks());
const source = 'rtk2-544553544e455431-4242';

describe('RTK2 wire and application integrity', () => {
	it('matches a firmware-derived synthetic known vector and standard CRC8/MAXIM', () => {
		const wire = Uint8Array.from('320f811de4f3bdde0d1e723de4f3bdde320f811d103ab9618a1acada8b1b'.match(/../g), (v) => parseInt(v, 16));
		expect(decodeRtk2Bytes(wire)).toEqual(Uint8Array.from({ length: 30 }, (_, i) => i));
		expect(crc8Maxim(new TextEncoder().encode('123456789'))).toBe(0xa1);
	});
	it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 225])('handles a %i-byte correction chunk and every short-block remainder', (length) => {
		const payload = Uint8Array.from({ length }, (_, i) => i);
		expect(decodeRtk2Frame(mockRtk2Packet(payload))).toMatchObject({ address: 4242, sequence: 100, body: payload });
	});
	it('rejects damage to the outer CRC, inner CRC, magic, length, terminator and PHY', () => {
		const good = mockRtk2Packet(mockRtcmReference());
		const plain = mockRtk2Plain(mockRtcmReference());
		for (const offset of [0, 12, 18, plain.length - 4, plain.length - 2]) {
			const bad = plain.slice();
			bad[offset] ^= 1;
			// Repair the outer CRC to independently exercise the inner checksum and structural checks.
			bad[bad.length - 3] = mockRtk2Checks(bad.slice(0, -3), 8);
			expect(decodeRtk2Frame({ ...good, data: mockRtk2Wire(bad) })).toBeUndefined();
		}
		const damaged = { ...good, data: good.data.slice() };
		damaged.data[10] ^= 1;
		for (const bad of [
			damaged,
			{ ...good, codingErrors: 1 },
			{ ...good, codingRate: 2 },
			{ ...good, hasCrc: true },
			{ ...good, data: new Uint8Array(256) },
		])
			expect(decodeRtk2Frame(bad)).toBeUndefined();
	});
});

describe('RTK2 correction stream', () => {
	it('reassembles maximum-length RTCM across containers and keepalives, with multiple frames per chunk', () => {
		const header = new Uint8Array(1026);
		header.set([0xd3, 3, 255, 255, 160, 42]);
		const crc = crc24q(header);
		const frame = Uint8Array.from([...header, crc >> 16, (crc >> 8) & 255, crc & 255]);
		const bytes = Uint8Array.from([...mockRtcmReference(), ...frame, ...mockRtcmReference()]);
		const tracker = new Rtk2Tracker();
		let sequence = 100;
		for (let at = 0; at < bytes.length; at += 225) {
			tracker.process(mockRtk2Packet(bytes.slice(at, at + 225), sequence++));
			tracker.process(mockRtk2Packet(new Uint8Array(), sequence++));
		}
		expect(tracker.flush().map((f) => [f.type, f.source])).toEqual([
			[1006, source],
			[4090, source],
			[1006, source],
		]);
		expect(tracker.counters).toMatchObject({ packets: 10, beacons: 5, containers: 10, crcErrors: 0, containerErrors: 0 });
	});
	it('isolates networks and addresses, suppresses duplicates and handles wrap and restarts', () => {
		const frame = mockRtcmReference();
		const tracker = new Rtk2Tracker();
		tracker.process(mockRtk2Packet(frame.slice(0, 12), 65535));
		tracker.process(mockRtk2Packet(frame, 100, 4243));
		tracker.process(mockRtk2Packet(frame, 100, 4242, 'TESTNET2'));
		tracker.process(mockRtk2Packet(frame.slice(12), 0));
		tracker.process(mockRtk2Packet(frame.slice(12), 0));
		tracker.process(mockRtk2Packet(frame, 1));
		tracker.process(mockRtk2Packet(frame, 0));
		expect(tracker.flush()).toHaveLength(5);
		expect(tracker.snapshot()).toHaveLength(3);
		expect(tracker.counters.sequenceGaps).toBe(0);
	});
	it('discards partial corrections on missing packets, bad CRC, IQ gaps and long silence', () => {
		const frame = mockRtcmReference();
		let now = 20000;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		for (const [interrupt, nextSequence] of [
			[(tracker) => tracker.process(mockRtk2Packet(new Uint8Array(), 102)), 103],
			[(tracker) => tracker.process({ ...mockRtk2Packet(frame, 101), codingErrors: 1 }), 101],
			[(tracker) => tracker.discontinuity(), 101],
			[
				() => {
					now += 3000;
				},
				101,
			],
		]) {
			const tracker = new Rtk2Tracker();
			tracker.process(mockRtk2Packet(frame.slice(0, 12), 100));
			interrupt(tracker);
			tracker.process(mockRtk2Packet(frame.slice(12), nextSequence));
			expect(tracker.flush()).toEqual([]);
			tracker.process(mockRtk2Packet(frame, nextSequence + 1));
			expect(tracker.flush()).toHaveLength(1);
		}
	});
	it('rejects RTCM CRC damage and bounds base streams and pending exports', () => {
		const tracker = new Rtk2Tracker();
		const bad = mockRtcmReference();
		bad[10] ^= 1;
		tracker.process(mockRtk2Packet(bad, 0));
		expect(tracker.flush()).toEqual([]);
		for (let address = 1; address <= 17; address++) tracker.process(mockRtk2Packet(mockRtcmReference().slice(0, 12), 0, address));
		expect(tracker.snapshot()).toHaveLength(16);
		tracker.process(mockRtk2Packet(mockRtcmReference().slice(12), 1, 1));
		expect(tracker.flush()).toEqual([]);
		for (let sequence = 10; sequence < 80; sequence++) tracker.process(mockRtk2Packet(mockRtcmReference(), sequence));
		expect(tracker.flush()).toHaveLength(64);
	});
});
