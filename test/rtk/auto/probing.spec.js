import { afterEach, describe, expect, it, vi } from 'vitest';
import { RtkStream } from '@/worker/decoders/rtk/stream';
import { mockRtkIq } from '../../fixtures/rtk/mock-iq';
import { mockRtk3Beacon, mockRtk3Packet, mockRtk3Container, mockRtk3Options } from '../../fixtures/rtk/mock-rtk3';

afterEach(() => vi.restoreAllMocks());
describe('automatic hop probing through the streaming path', () => {
	it.each([false, true])('shares acquisition and follows only a verified hopping source: %s', (hopping) => {
		const source = new Float32Array(8000000),
			memory = { buffer: new ArrayBuffer(655360) };
		const packets = [
			[100000, mockRtk3Beacon()],
			[hopping ? 700000 : 300000, mockRtk3Beacon()],
			[3500000, mockRtk3Packet(mockRtk3Container())],
		];
		if (hopping) packets.push([1300000, mockRtk3Beacon()]);
		for (const [sample, packet] of packets) {
			const iq = mockRtkIq(packet.data, mockRtk3Options);
			source.set(
				Float32Array.from(new Int8Array(iq.buffer), (value) => value / 128),
				sample * 2,
			);
		}
		let rawOffset = 0,
			created = 0,
			freed = 0,
			now = performance.now();
		const shifts = [],
			messages = [];
		class Ddc {
			constructor(rate, shift) {
				this.shift = shift;
				created++;
			}
			set_if_sample_rate() {}
			set_bandwidth() {}
			set_shift(rate, shift) {
				this.shift = shift;
				shifts.push(shift);
			}
			reset() {}
			free() {
				freed++;
			}
			process_iq_only_ptr(ptr, values) {
				const start = Math.floor((rawOffset + ptr) / 40) * 2,
					end = Math.floor((rawOffset + ptr + values) / 40) * 2;
				this.count = end - start;
				const output = new Float32Array(memory.buffer, 327680, this.count);
				if (hopping || Math.abs(this.shift + 7717000) < 1) output.set(source.subarray(start, end));
				else output.fill(0);
				return 327680;
			}
			get_iq_output_len() {
				return this.count;
			}
			process_iq_only_f32_ptr(ptr, values) {
				this.count = values;
				return ptr;
			}
		}
		vi.spyOn(performance, 'now').mockImplementation(() => (now += 300));
		const stream = new RtkStream(Ddc, memory, (message) => messages.push(message));
		stream.configure({ freq: 915.401, rtk: true, rtkProfile: 'auto' }, 20000000, 923.118);
		for (let id = 0; rawOffset < 160000000; rawOffset += 327680) stream.process(0, Math.min(327680, 160000000 - rawOffset), false, ++id);
		stream.emit();
		expect(created).toBe(2);
		expect(freed).toBe(1);
		expect(messages.at(-1).status.detectedProfile).toBe('rtk3');
		expect(messages.at(-1).status.hopDecision).toBe(hopping ? 'following' : 'unconfirmed');
		expect(messages.flatMap((message) => message.rtcm).map((frame) => frame.type)).toEqual([1006]);
		if (!hopping) expect(shifts.at(-1)).toBeCloseTo(-7717000);
		stream.reset();
		expect(freed).toBe(2);
	});
});
