import { afterEach, describe, expect, it, vi } from 'vitest';
import { RtkStream } from '@/worker/decoders/rtk/stream';
import { mockRtkIq } from '../../fixtures/rtk/mock-iq';
import { mockRadioPayload } from '../../fixtures/rtk/mock-packet';
import { mockRtk3Packet, mockRtk3Beacon, mockRtk3Container, mockRtk3Options, mockRtcmReference } from '../../fixtures/rtk/mock-rtk3';
import { mockRtk2Packet, mockRtk2Options } from '../../fixtures/rtk/mock-rtk2';

afterEach(() => vi.restoreAllMocks());
function setup(frequency = 923.118, source = '') {
	const memory = { buffer: new ArrayBuffer(65536) },
		messages = [];
	const stream = new RtkStream(
		class {
			constructor() {
				throw Error('A narrow capture must not allocate a hop DDC');
			}
		},
		memory,
		(message) => messages.push(message),
	);
	stream.configure({ rtk: true, freq: frequency, rtkProfile: 'auto', rtkFollowSource: source }, 1000000, frequency);
	let id = 0,
		now = performance.now();
	vi.spyOn(performance, 'now').mockImplementation(() => (now += 300));
	const feed = (packet, options) => {
		const bytes = mockRtkIq(packet, options);
		for (let at = 0; at < bytes.length; at += 8190) {
			const part = bytes.subarray(at, at + 8190);
			new Uint8Array(memory.buffer).set(part);
			stream.process(0, part.length, false, ++id);
		}
		stream.emit();
	};
	return { feed, stream, messages };
}

describe('automatic profile acquisition from synthetic IQ', () => {
	it('keeps RTK2 bases with a reused address on different networks separate', () => {
		const network = 'TESTNET1',
			source = `rtk2-${Array.from(new TextEncoder().encode(network), (byte) => byte.toString(16).padStart(2, '0')).join('')}-4242`;
		const { feed, messages } = setup(923.118, source);
		for (const [sequence, net] of ['TESTNET2', network, network, 'TESTNET2', network].entries())
			feed(mockRtk2Packet(mockRtcmReference(), sequence + 1, 4242, net).data, mockRtk2Options);
		expect(messages.at(-1).stations).toHaveLength(1);
		expect(messages.at(-1).stations[0]).toMatchObject({ address: 4242, rtcmCount: 3 });
	});
	it('keeps overlapping RTK3 header identities out of a source-locked follower', () => {
		const { feed, messages } = setup(923.118, 'rtk3-100-4242');
		feed(mockRtk3Beacon(4242, 100, 101).data, mockRtk3Options);
		expect(messages.at(-1).status.detectedProfile).toBeUndefined();
		feed(mockRtk3Beacon(4242, 100, 100).data, mockRtk3Options);
		expect(messages.at(-1).status.detectedProfile).toBe('rtk3');
		for (const [sequence, prefix] of [101, 100, 101, 100].entries())
			feed(mockRtk3Packet(mockRtk3Container(undefined, sequence + 1), 4242, prefix).data, mockRtk3Options);
		expect(messages.at(-1).stations).toHaveLength(1);
		expect(messages.at(-1).stations[0]).toMatchObject({ address: 4242, addressPrefix: 100, rtcmCount: 2 });
	});
	it.each(['rtk1', 'rtk2', 'rtk3'])('detects %s and preserves corrections received during acquisition', (profile) => {
		const { feed, messages } = setup();
		const packets =
			profile === 'rtk1'
				? [mockRadioPayload(), mockRadioPayload()]
				: profile === 'rtk2'
					? [100, 101].map((sequence) => mockRtk2Packet(mockRtcmReference(), sequence).data)
					: [100, 101].map((sequence) => mockRtk3Packet(mockRtk3Container(undefined, sequence), 4242, 100).data);
		const options = profile === 'rtk1' ? {} : profile === 'rtk2' ? mockRtk2Options : mockRtk3Options;
		feed(packets[0], options);
		expect(messages.at(-1).status.detectedProfile).toBeUndefined();
		feed(packets[1], options);
		expect(messages.at(-1)).toMatchObject({ profile, status: { detectedProfile: profile, hopDecision: 'fixed' } });
		expect(messages.flatMap((message) => message.rtcm)).toHaveLength(2);
		expect(messages.at(-1).stations[0].reference).toMatchObject({ latitude: 0, longitude: 0 });
	});
	it('detects RTK3 beacons in narrow IQ without declaring or attempting full-band hopping', () => {
		const { feed, messages } = setup(915.401);
		for (let i = 0; i < 2; i++) feed(mockRtk3Beacon().data, mockRtk3Options);
		expect(messages.at(-1).status).toMatchObject({ detectedProfile: 'rtk3', hopDecision: 'band-limited', hopTracking: false });
		expect(messages.at(-1).status.state).toBe('receiving');
	});
	it('lets manual mode force another profile and resets detection on retune and disable', () => {
		const { feed, messages, stream } = setup();
		for (let i = 0; i < 2; i++) feed(mockRtk3Packet(mockRtk3Container()).data, mockRtk3Options);
		stream.configure({ rtk: true, freq: 923.118, rtkProfile: 'rtk2' }, 1000000, 923.118);
		feed(mockRtk3Packet(mockRtk3Container()).data, mockRtk3Options);
		expect(messages.at(-1)).toMatchObject({ profile: 'rtk2', stations: [], status: { packets: 0 } });
		stream.configure({ rtk: true, freq: 924.118, rtkProfile: 'auto' }, 1000000, 924.118);
		expect(messages.at(-1).status.detectedProfile).toBeUndefined();
		stream.configure({ rtk: false, freq: 924.118, rtkProfile: 'auto' }, 1000000, 924.118);
		expect(messages.at(-1).status.state).toBe('off');
	});
});
