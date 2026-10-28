import { afterEach, describe, expect, it, vi } from 'vitest';
import { RtkStream } from '@/worker/decoders/rtk/stream';
import { mockRtkIq } from '../fixtures/rtk/mock-iq';
import { mockRtk2Packet, mockRtk2Options } from '../fixtures/rtk/mock-rtk2';
import { mockRtcmReference } from '../fixtures/rtk/mock-rtk3';

afterEach(() => vi.restoreAllMocks());

describe('RTK2 browser worker with synthetic signed IQ', () => {
	it('decodes corrections through the RTK2 profile and resets on retune and profile change', () => {
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
		stream.configure({ freq: 924.118, rtk: true, rtkProfile: 'rtk2' }, 1000000, 924.118);
		let now = performance.now() + 1000,
			id = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => (now += 300));
		const frame = mockRtcmReference();
		for (const packet of [
			mockRtk2Packet(frame.slice(0, 12), 100),
			mockRtk2Packet(new Uint8Array(), 101),
			mockRtk2Packet(frame.slice(12), 102),
		]) {
			const bytes = mockRtkIq(packet.data, mockRtk2Options);
			for (let at = 0; at < bytes.length; at += 8190) {
				const part = bytes.subarray(at, at + 8190);
				new Uint8Array(memory.buffer).set(part);
				stream.process(0, part.length, false, ++id);
			}
		}
		expect(messages.at(-1)).toMatchObject({
			profile: 'rtk2',
			status: { payloads: 3, packets: 3, beacons: 1, crcErrors: 0, containers: 3 },
		});
		expect(messages.at(-1).stations[0]).toMatchObject({
			protocol: 'rtk2',
			address: 4242,
			rtcmCount: 1,
			reference: { latitude: 0, longitude: 0 },
		});
		expect(messages.flatMap((m) => m.rtcm).map((f) => f.type)).toEqual([1006]);
		stream.configure({ freq: 915.19, rtk: true, rtkProfile: 'rtk2' }, 1000000, 915.19);
		expect(messages.at(-1).stations).toEqual([]);
		stream.configure({ freq: 915.19, rtk: true, rtkProfile: 'lower' }, 1000000, 915.19);
		expect(messages.at(-1)).toMatchObject({ profile: 'lower', stations: [], status: { packets: 0 } });
	});
});
