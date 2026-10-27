import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockRtkIq } from '../fixtures/rtk/mock-iq';
import { mockRadioPayload } from '../fixtures/rtk/mock-packet';
import { RtkStream } from '@/worker/decoders/rtk/stream';
import { RtkTracker, crc24q } from '@/worker/decoders/rtk/rtcm';

function setup() {
	const memory = { buffer: new ArrayBuffer(65536) };
	const messages = [];
	const stream = new RtkStream(
		class {
			constructor() {
				throw new Error('Unexpected DDC');
			}
		},
		memory,
		(message) => messages.push(message),
	);
	stream.configure({ freq: 923.118, rtk: true, rtkProfile: 'luba1', rtkClockPpm: 20 }, 1000000, 923.118);
	return { stream, memory, messages };
}

describe('live RTK stream', () => {
	afterEach(() => vi.restoreAllMocks());

	it('decodes signed USB IQ with audio disabled and stops when decoding is disabled', () => {
		const { stream, memory, messages } = setup();
		const bytes = mockRtkIq();
		let now = performance.now() + 1000;
		vi.spyOn(performance, 'now').mockImplementation(() => (now += 300));
		for (let at = 0, id = 1; at < bytes.length; at += 16384, id++) {
			const part = bytes.subarray(at, at + 16384);
			new Uint8Array(memory.buffer).set(part);
			stream.process(0, part.length, false, id);
		}
		expect(messages.at(-1).status.packets).toBe(1);
		expect(messages.at(-1).stations[0].name).toBe('RTK base station');
		expect(messages.at(-1).stations[0]).toMatchObject({
			scan: 1234,
			channel: 7,
			netId: 42,
			reference: { stationId: 42, latitude: 0, longitude: 0, heightM: 0 },
		});
		expect(messages.flatMap((message) => message.rtcm).map((frame) => frame.type)).toEqual([1006]);
		expect(messages.flatMap((message) => message.rtcm)).toHaveLength(1);
		stream.configure({ freq: 923.118, rtk: false }, 1000000, 923.118);
		expect(messages.at(-1).status.state).toBe('off');
	});

	it('publishes two bases received at the same VFO frequency from synthetic IQ', () => {
		const { stream, memory, messages } = setup();
		const a = mockRtkIq(),
			b = mockRtkIq(mockRadioPayload({ scan: 2345, channel: 8, netId: 43 }, [0, 63781370000, 0]));
		const bytes = new Uint8Array(a.length + b.length);
		bytes.set(a);
		bytes.set(b, a.length);
		let now = performance.now() + 1000;
		vi.spyOn(performance, 'now').mockImplementation(() => (now += 300));
		for (let at = 0, id = 1; at < bytes.length; at += 16384, id++) {
			const part = bytes.subarray(at, at + 16384);
			new Uint8Array(memory.buffer).set(part);
			stream.process(0, part.length, false, id);
		}
		expect(messages.at(-1).stations).toHaveLength(2);
		expect(messages.at(-1).status.packets).toBe(2);
		expect(messages.flatMap((message) => message.rtcm).map((frame) => frame.source)).toEqual(['1234.7.42', '2345.8.43']);
	});

	it('drops incomplete packets on a sequence gap and reports it', () => {
		const { stream, memory, messages } = setup();
		const bytes = mockRtkIq();
		let now = performance.now() + 1000;
		vi.spyOn(performance, 'now').mockImplementation(() => (now += 300));
		for (let at = 0, id = 1; at < bytes.length; at += 16384, id++) {
			const part = bytes.subarray(at, at + 16384);
			new Uint8Array(memory.buffer).set(part);
			stream.process(0, part.length, false, id + (at >= 65536 ? 1 : 0));
		}
		expect(messages.at(-1).status.discontinuities).toBe(1);
		expect(messages.at(-1).status.packets).toBe(0);
		expect(messages.flatMap((message) => message.rtcm)).toEqual([]);
	});

	it('resets partial acquisition on retune and rejects unsupported configurations', () => {
		const { stream, memory, messages } = setup();
		const bytes = mockRtkIq();
		let now = performance.now() + 1000;
		vi.spyOn(performance, 'now').mockImplementation(() => (now += 300));
		for (let at = 0, id = 1; at < bytes.length; at += 16384, id++) {
			if (at === 65536) stream.configure({ freq: 923.119, rtk: true }, 1000000, 923.119);
			const part = bytes.subarray(at, at + 16384);
			new Uint8Array(memory.buffer).set(part);
			stream.process(0, part.length, false, id);
		}
		expect(messages.at(-1).status.packets).toBe(0);
		expect(messages.flatMap((message) => message.rtcm)).toEqual([]);
		stream.configure({ freq: 923.118, rtk: true }, 500000, 923.118);
		expect(messages.at(-1).status.state).toBe('error');
		stream.configure({ freq: 923.118, rtk: true, rtkClockPpm: 201 }, 1000000, 923.118);
		expect(messages.at(-1).status.state).toBe('error');
	});
});

describe('RTCM validation', () => {
	it('checks CRC24Q against a standard vector and refuses corrupted or unchecked packets', () => {
		expect(crc24q(new TextEncoder().encode('123456789'))).toBe(0xcde703);
		const bytes = Uint8Array.from([0xd3, 0, 3, 0x43, 0x20, 1]);
		const checksum = crc24q(bytes);
		const body = Uint8Array.from([...bytes, checksum >> 16, (checksum >> 8) & 255, checksum & 255]);
		const packet = (part, verified = true) => ({
			data: Uint8Array.from([0x2c, 7, 0, 0, 42, 4, 0xd2, part.length, ...part.map((byte) => byte ^ 0x12)]),
			verified,
			cfoHz: 0,
		});
		const tracker = new RtkTracker();
		tracker.process(packet(body.slice(0, 5)));
		tracker.process(packet(body.slice(5)));
		expect(tracker.flush()[0].type).toBe(1074);
		body[4] ^= 1;
		tracker.process(packet(body));
		expect(tracker.flush()).toEqual([]);
		tracker.process(packet(bytes.slice(0, 5)));
		tracker.process(packet(new Uint8Array(), false));
		tracker.process(packet(body.slice(5)));
		expect(tracker.flush()).toEqual([]);
	});
});
