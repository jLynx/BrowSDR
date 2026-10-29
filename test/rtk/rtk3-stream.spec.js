import { afterEach, describe, expect, it, vi } from 'vitest';
import { RtkStream } from '@/worker/decoders/rtk/stream';
import { mockRtkIq } from '../fixtures/rtk/mock-iq';
import { mockRtk3Packet, mockRtk3Beacon, mockRtk3Container, mockRtk3Options } from '../fixtures/rtk/mock-rtk3';

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
	stream.configure({ freq: 923.6, rtk: true, rtkProfile: 'rtk3' }, 1000000, 923.6);
	let now = performance.now() + 1000,
		id = 0;
	vi.spyOn(performance, 'now').mockImplementation(() => (now += 300));
	function feed(packet, gap = false) {
		const bytes = mockRtkIq(packet.data, mockRtk3Options);
		for (let at = 0; at < bytes.length; at += 8190) {
			const part = bytes.subarray(at, at + 8190);
			new Uint8Array(memory.buffer).set(part);
			stream.process(0, part.length, false, ++id);
			if (gap && at === 32760) id++;
		}
	}
	return { stream, messages, feed };
}

afterEach(() => vi.restoreAllMocks());

describe('RTK3 browser worker path with synthetic signed IQ', () => {
	it('verifies application frames despite absent LoRa CRC, strips beacons and decodes split RTCM', () => {
		const { messages, feed } = setup();
		const container = mockRtk3Container();
		feed(mockRtk3Packet(container.slice(0, 18)));
		feed(mockRtk3Beacon());
		feed(mockRtk3Packet(container.slice(18)));
		expect(messages.at(-1)).toMatchObject({
			profile: 'rtk3',
			status: { packets: 3, payloads: 3, beacons: 1, containers: 1, codingErrors: 0, crcErrors: 0 },
		});
		expect(messages.at(-1).stations[0]).toMatchObject({ address: 4242, rtcmCount: 1, reference: { latitude: 0, longitude: 0 } });
		expect(messages.flatMap((message) => message.rtcm).map((frame) => [frame.type, frame.source])).toEqual([[1006, 'rtk3-4242']]);
	});

	it('reports failed frame CRC and resets on an IQ gap, retune or profile change', () => {
		const { stream, messages, feed } = setup();
		const corrupt = mockRtk3Packet(mockRtk3Container());
		corrupt.data[10] ^= 1;
		feed(corrupt);
		expect(messages.at(-1).status).toMatchObject({ payloads: 1, packets: 0, crcErrors: 1 });
		feed(mockRtk3Packet(mockRtk3Container()), true);
		expect(messages.at(-1).status.discontinuities).toBe(1);
		expect(messages.flatMap((message) => message.rtcm)).toEqual([]);
		feed(mockRtk3Packet(mockRtk3Container()));
		expect(messages.flatMap((message) => message.rtcm)).toHaveLength(1);
		stream.configure({ freq: 924.6, rtk: true, rtkProfile: 'rtk3' }, 1000000, 924.6);
		expect(messages.at(-1).stations).toEqual([]);
		stream.configure({ freq: 924.6, rtk: true, rtkProfile: 'rtk2', rtkClockPpm: 0 }, 1000000, 924.6);
		feed(mockRtk3Packet(mockRtk3Container()));
		expect(messages.at(-1)).toMatchObject({ profile: 'rtk2', stations: [], status: { payloads: 0, packets: 0 } });
	});
});
