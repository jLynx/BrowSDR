import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeRtk2Frame } from '@/worker/decoders/rtk/rtk2/frame';
import { Rtk2Tracker } from '@/worker/decoders/rtk/rtk2/tracker';
import { LoraReceiver } from '@/worker/decoders/rtk/lora';
import { RTK_PROFILES } from '@/worker/decoders/rtk/stream';
import { mockRtk2Compact, mockRtk2Packet, mockRtk2Options, mockRtk2Beacon, mockRtk2Wire, mockRtk2Checks } from '../fixtures/rtk/mock-rtk2';
import { decodeRtk2Bytes } from '@/worker/decoders/rtk/rtk2/transform';
import { mockRtcmReference } from '../fixtures/rtk/mock-rtk3';
import { mockRtkIq } from '../fixtures/rtk/mock-iq';

afterEach(() => vi.restoreAllMocks());

describe('RTK2 compact raw correction stream', () => {
	it('checks control-beacon structure and CRC, strips it from corrections and detects a restart', () => {
		const good = mockRtk2Beacon();
		expect(decodeRtk2Frame(good)).toMatchObject({ hopSlot: 9, beaconSeconds: 100, body: new Uint8Array() });
		const plain = decodeRtk2Bytes(good.data);
		for (const offset of [12, 14, 15, 20, 21]) {
			const bad = plain.slice();
			bad[offset] = 255;
			bad[22] = mockRtk2Checks(bad.slice(0, 22), 8);
			expect(decodeRtk2Frame({ ...good, data: mockRtk2Wire(bad) })).toBeUndefined();
		}
		const tracker = new Rtk2Tracker(),
			frame = mockRtcmReference();
		tracker.process(good);
		tracker.process(mockRtk2Compact(frame.slice(0, 12)));
		tracker.process(mockRtk2Beacon(15, 101));
		tracker.process(mockRtk2Compact(frame.slice(12), 15));
		expect(tracker.flush()).toHaveLength(1);
		tracker.process(mockRtk2Compact(frame.slice(0, 12), 15));
		tracker.process(mockRtk2Beacon(4, 1));
		tracker.process(mockRtk2Compact(frame.slice(12), 4));
		expect(tracker.flush()).toEqual([]);
		expect(tracker.counters.beacons).toBe(3);
	});
	it('reassembles corrections after NMEA bytes across equal opaque header fields', () => {
		const tracker = new Rtk2Tracker();
		const frame = mockRtcmReference();
		tracker.process(mockRtk2Compact(Uint8Array.from([...new TextEncoder().encode('$GNGGA,TEST\r\n'), ...frame.slice(0, 12)])));
		tracker.process(mockRtk2Compact(frame.slice(12)));
		expect(tracker.flush().map((f) => f.type)).toEqual([1006]);
		expect(tracker.counters).toMatchObject({ packets: 2, crcErrors: 0, containers: 0, sequenceGaps: 0 });
		expect(tracker.snapshot()[0]).toMatchObject({ protocol: 'rtk2', address: 4242, reference: { latitude: 0, longitude: 0 } });
		expect(tracker.snapshot()[0].loc).toBeUndefined();
	});
	it.each([0, 1, 2, 7, 8, 9, 239, 240])('validates a %i-byte compact body and the transform tail', (length) => {
		const body = Uint8Array.from({ length }, (_, i) => i * 37);
		expect(decodeRtk2Frame(mockRtk2Compact(body))).toMatchObject({ format: 'compact', body, address: 4242 });
	});
	it('requires compact frame length, CRC8 and the expected PHY', () => {
		const good = mockRtk2Compact(mockRtcmReference());
		const bad = { ...good, data: good.data.slice() };
		bad.data[12] ^= 1;
		for (const packet of [
			bad,
			{ ...good, codingErrors: 1 },
			{ ...good, hasCrc: true },
			{ ...good, codingRate: 2 },
			mockRtk2Compact(new Uint8Array(241)),
		])
			expect(decodeRtk2Frame(packet)).toBeUndefined();
	});
	it.each(['radio', 'header', 'iq', 'silence', 'format'])('discards unsequenced tails after %s loss or change', (reason) => {
		const tracker = new Rtk2Tracker();
		const frame = mockRtcmReference();
		let now = 20000;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		tracker.process(mockRtk2Compact(frame.slice(0, 12)));
		if (reason === 'radio') tracker.process({ ...mockRtk2Compact(frame), codingErrors: 1 });
		if (reason === 'header') tracker.rejectCandidate();
		if (reason === 'iq') tracker.discontinuity();
		if (reason === 'silence') now += 3000;
		if (reason === 'format') tracker.process(mockRtk2Packet(new Uint8Array(), 100));
		tracker.process(mockRtk2Compact(frame.slice(12)));
		expect(tracker.flush()).toEqual([]);
		tracker.process(mockRtk2Compact(frame));
		expect(tracker.flush()).toHaveLength(1);
	});
	it('keeps simultaneous network/address streams isolated and validates RTCM independently', () => {
		const tracker = new Rtk2Tracker();
		const frame = mockRtcmReference();
		tracker.process(mockRtk2Compact(frame.slice(0, 12)));
		tracker.process(mockRtk2Compact(frame, 9, 4243));
		tracker.process(mockRtk2Compact(frame, 9, 4242, 'TESTNET2'));
		tracker.process(mockRtk2Compact(frame.slice(12)));
		expect(tracker.flush()).toHaveLength(3);
		frame[10] ^= 1;
		tracker.process(mockRtk2Compact(frame));
		expect(tracker.flush()).toEqual([]);
	});
	it('decodes the alternate private sync through the production LoRa receiver', () => {
		const tracker = new Rtk2Tracker();
		const bytes = mockRtkIq(mockRtk2Compact(mockRtcmReference()).data, { ...mockRtk2Options, sync: [8, 16] });
		const receiver = new LoraReceiver(RTK_PROFILES.rtk2, 10, (packet) => tracker.process(packet));
		const iq = Float32Array.from(new Int8Array(bytes.buffer), (value) => value / 128);
		for (let at = 0; at < iq.length; at += 8190) receiver.process(iq.subarray(at, at + 8190));
		expect(receiver.counters.syncSymbols).toEqual([8, 16]);
		expect(tracker.flush().map((f) => f.type)).toEqual([1006]);
	});
	it('recovers a long packet with clock drift using its application checksum, emitting it once', () => {
		const payload = new Uint8Array(240);
		payload.set(mockRtcmReference());
		const bytes = mockRtkIq(mockRtk2Compact(payload).data, { ...mockRtk2Options, sync: [8, 16], clockPpm: 20 });
		const packets = [];
		const receiver = new LoraReceiver(
			RTK_PROFILES.rtk2,
			0,
			(packet) => packets.push(packet),
			undefined,
			(packet) => !!decodeRtk2Frame(packet),
		);
		const iq = Float32Array.from(new Int8Array(bytes.buffer), (value) => value / 128);
		for (let at = 0; at < iq.length; at += 8190) receiver.process(iq.subarray(at, at + 8190));
		expect(packets).toHaveLength(1);
		expect(decodeRtk2Frame(packets[0]).body).toEqual(payload);
		expect(receiver.counters).toMatchObject({ payloads: 1, codingErrors: 0 });
	});
});
