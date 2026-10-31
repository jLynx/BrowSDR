import { describe, expect, it, vi } from 'vitest';
import { RtkHopFollower } from '@/worker/decoders/rtk/hopping/follower';
import { RtkStream } from '@/worker/decoders/rtk/stream';
import { mockRtkIq } from '../fixtures/rtk/mock-iq';
import { mockRtk3Beacon, mockRtk3Packet, mockRtk3Container, mockRtk3Options } from '../fixtures/rtk/mock-rtk3';
import { mockRtk2Compact, mockRtk2Options } from '../fixtures/rtk/mock-rtk2';
import { mockRtcmReference } from '../fixtures/rtk/mock-rtk3';
import { stationKey } from '@/worker/decoders/rtk/station-key';
import { decodeRtk2Frame } from '@/worker/decoders/rtk/rtk2/frame';

describe('recorded NZ RTK3 hop following', () => {
	it('waits for the selected base and retains that choice after reacquisition', () => {
		const hop = new RtkHopFollower('rtk3', 915401000, 'rtk3-100-4242');
		hop.beacon('rtk3-101-4242', 1.010368);
		expect(hop.tracking).toBe(false);
		hop.beacon('rtk3-100-4242', 2.010368);
		expect(hop.tracking).toBe(true);
		hop.reset();
		hop.beacon('rtk3-101-4242', 3.010368);
		expect(hop.tracking).toBe(false);
		hop.beacon('rtk3-100-4242', 4.010368);
		expect(hop.tracking).toBe(true);
	});
	it('follows the nonascending RTK2 plan, including the extra lowest slot and lap wrap', () => {
		const hop = new RtkHopFollower('rtk2', 921791000);
		hop.beacon('TESTNET1-4242', 1.010368);
		const frequencies = [];
		for (let i = 0; i < 18; i++) {
			hop.advance(1.941 + i);
			frequencies.push(hop.frequencyHz);
			hop.beacon('TESTNET1-4242', 2.010368 + i);
		}
		expect(frequencies.slice(0, 3)).toEqual([925991000, 918291000, 922491000]);
		expect(frequencies.slice(6, 9)).toEqual([927391000, 915491000, 919691000]);
		expect(frequencies.at(-1)).toBe(921791000);
	});
	it.each([
		{ profile: 'rtk3', prefix: 0, preferred: false, frequency: 915.401, next: 915.901, second: 800000 },
		{ profile: 'rtk3', prefix: 100, preferred: true, frequency: 915.401, next: 915.901, second: 800000 },
		{ profile: 'rtk2', prefix: 0, preferred: false, frequency: 921.791, next: 925.991, second: 1200000 },
		{ profile: 'rtk2', prefix: 0, preferred: true, frequency: 921.791, next: 925.991, second: 1200000 },
	])(
		'follows $profile beacons with prefix $prefix and preference $preferred',
		({ profile, prefix, preferred, frequency, next, second }) => {
			const memory = { buffer: new ArrayBuffer(655360) };
			const channel = new Float32Array(3200000);
			const container = profile === 'rtk3' ? mockRtk3Container() : mockRtcmReference();
			const options = profile === 'rtk3' ? mockRtk3Options : { ...mockRtk2Options, sync: [8, 16] };
			const makePacket = (body, slot) => (profile === 'rtk3' ? mockRtk3Packet(body, 4242, prefix) : mockRtk2Compact(body, slot));
			for (const [start, packet] of [
				[100000, profile === 'rtk3' ? mockRtk3Beacon(4242, 15000, prefix) : mockRtk2Compact(new Uint8Array(), 9)],
				[200000, makePacket(container.slice(0, 18), 9)],
				[second, makePacket(container.slice(18), 15)],
			]) {
				const bytes = mockRtkIq(packet.data, options);
				channel.set(
					Float32Array.from(new Int8Array(bytes.buffer), (value) => value / 128),
					start * 2,
				);
			}
			const shifts = [],
				messages = [];
			let emitted = 0,
				count = 0;
			class Ddc {
				set_if_sample_rate() {}
				set_bandwidth() {}
				set_shift(rate, shift) {
					shifts.push([rate, shift]);
				}
				reset() {}
				free() {}
				process_iq_only_ptr(ptr, values) {
					count = Math.floor(values / 40) * 2;
					new Float32Array(memory.buffer, 327680, count).set(channel.subarray(emitted, emitted + count));
					emitted += count;
					return 327680;
				}
				get_iq_output_len() {
					return count;
				}
			}
			let now = performance.now() + 1000;
			const clock = vi.spyOn(performance, 'now').mockImplementation(() => (now += 300));
			try {
				const stream = new RtkStream(Ddc, memory, (message) => messages.push(message));
				const identity =
					profile === 'rtk3'
						? { address: 4242, addressPrefix: prefix, netId: 4242 }
						: { protocol: 'rtk2', netId: 4242, ...decodeRtk2Frame(makePacket(container, 9)) };
				stream.configure(
					{ freq: frequency, rtk: true, rtkProfile: profile, rtkFollowHops: true, rtkFollowSource: preferred ? stationKey(identity) : '' },
					20000000,
					923.118,
				);
				for (let at = 0, id = 0; at < 64000000; at += 327680) stream.process(0, Math.min(327680, 64000000 - at), false, ++id);
				expect(shifts[0][0]).toBe(20000000);
				expect(shifts[0][1]).toBeCloseTo((next - 923.118) * 1e6);
				expect(messages.flatMap((message) => message.rtcm).map((frame) => frame.type)).toEqual([1006]);
				expect(messages.at(-1).status.hopTracking).toBe(true);
			} finally {
				clock.mockRestore();
			}
		},
	);
	it('anchors only on beacons, wraps all 25 slots and retains timing through missed beacons', () => {
		const hop = new RtkHopFollower('rtk3', 927401000);
		expect(hop.advance(100)).toBe(false);
		hop.beacon(4242, 1.010368);
		expect(hop.advance(1.579)).toBe(false);
		expect(hop.advance(1.581)).toBe(true);
		expect(hop.frequencyHz).toBe(915401000);
		expect(hop.advance(2.781)).toBe(true);
		expect(hop.frequencyHz).toBe(916401000);
		// A different verified base must not move the chosen base's phase.
		hop.beacon(4243, 10);
		expect(hop.deadline).toBeCloseTo(3.38);
		hop.beacon(4242, 2.810368);
		expect(hop.deadline).toBeCloseTo(3.38);
	});
	it('returns to beacon hunting after a full lap of silence or an IQ gap', () => {
		const hop = new RtkHopFollower('rtk3', 915401000);
		hop.beacon(4242, 1.010368);
		hop.advance(16.7);
		expect(hop.tracking).toBe(false);
		expect(hop.deadline).toBe(Infinity);
		hop.beacon(4243, 17.010368);
		expect(hop.tracking).toBe(true);
		hop.reset();
		expect(hop.advance(100)).toBe(false);
	});
	it('requires the full hop plan inside the received band before allocating DSP', () => {
		const messages = [];
		const stream = new RtkStream(
			class {
				constructor() {
					throw new Error('Unexpected DSP');
				}
			},
			{ buffer: new ArrayBuffer(8) },
			(m) => messages.push(m),
		);
		stream.configure({ freq: 923.118, rtk: true, rtkProfile: 'rtk3', rtkFollowHops: true }, 10000000, 923.118);
		expect(messages.at(-1).status).toMatchObject({ state: 'error' });
		expect(messages.at(-1).status.message).toContain('915.251–927.551');
	});
});
