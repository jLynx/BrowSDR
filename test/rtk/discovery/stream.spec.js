import { afterEach, describe, expect, it, vi } from 'vitest';
import { RtkStream } from '@/worker/decoders/rtk/stream';
import { mockRtkIq } from '../../fixtures/rtk/mock-iq';
import { mockRadioPayload } from '../../fixtures/rtk/mock-packet';
import { mockRtk3Beacon, mockRtk3Packet, mockRtk3Container, mockRtk3Options, mockRtcmReference } from '../../fixtures/rtk/mock-rtk3';
import { mockRtk2Packet, mockRtk2Options } from '../../fixtures/rtk/mock-rtk2';

afterEach(() => vi.restoreAllMocks());

describe('RTK survey through the IQ streaming path', () => {
	it('advances by sample time, repeats the range, releases filters and reports input gaps', () => {
		let created = 0,
			freed = 0;
		class Ddc {
			constructor() {
				created++;
			}
			set_if_sample_rate() {}
			set_bandwidth() {}
			reset() {}
			free() {
				freed++;
			}
			process_iq_only_ptr() {
				return 0;
			}
			process_iq_only_f32_ptr() {
				return 0;
			}
			get_iq_output_len() {
				return 0;
			}
		}
		const messages = [],
			stream = new RtkStream(Ddc, { buffer: new ArrayBuffer(65536) }, (message) => messages.push(message));
		stream.configure({ rtk: true, freq: 100, rtkProfile: 'scan', rtkScanStart: 919, rtkScanEnd: 919.1 }, 2000000, 919.05);
		expect(messages.at(-1).status.scan).toMatchObject({ frequencyMHz: 919, channel: 1, pass: 1 });
		for (let id = 1; id <= 6; id++) stream.process(0, 1000000, false, id);
		stream.emit();
		expect(messages.at(-1).status.scan).toMatchObject({ frequencyMHz: 919.05, channel: 2 });
		for (let id = 8; id <= 19; id++) stream.process(0, 1000000, false, id);
		stream.emit();
		expect(messages.at(-1).status.scan.pass).toBe(2);
		expect(messages.at(-1).status.discontinuities).toBe(1);
		expect(created - freed).toBe(2);
		stream.reset();
		expect(freed).toBe(created);
	});
	it('continues after the first base and recognises mixed profiles with separately verified positions', () => {
		const memory = { buffer: new ArrayBuffer(65536) },
			messages = [];
		const stream = new RtkStream(
			class {
				constructor() {
					throw Error('A centred narrow recording must use its IQ directly');
				}
			},
			memory,
			(message) => messages.push(message),
		);
		stream.configure({ rtk: true, freq: 100, rtkProfile: 'scan', rtkScanStart: 923.118, rtkScanEnd: 923.118 }, 1000000, 923.118);
		let id = 0,
			now = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (now += 300));
		const feed = (packet, options) => {
			const iq = mockRtkIq(packet, options);
			for (let at = 0; at < iq.length; at += 8190) {
				const part = iq.subarray(at, at + 8190);
				new Uint8Array(memory.buffer).set(part);
				stream.process(0, part.length, false, ++id);
			}
			stream.emit();
		};
		feed(mockRtk3Beacon(4242, 100, 100).data, mockRtk3Options);
		feed(mockRtk3Beacon(4242, 100, 101).data, mockRtk3Options);
		expect(messages.at(-1).stations).toHaveLength(2);
		for (let i = 0; i < 2; i++) {
			feed(mockRadioPayload());
			feed(mockRtk2Packet(mockRtcmReference(), i + 1).data, mockRtk2Options);
			feed(mockRtk3Packet(mockRtk3Container(undefined, i + 1), 4242, 100).data, mockRtk3Options);
		}
		expect(messages.at(-1).status.scan).toMatchObject({ frequencyMHz: 923.118, channels: 1 });
		expect(
			messages
				.at(-1)
				.stations.map((station) => station.discovery.profile)
				.sort(),
		).toEqual(['rtk1', 'rtk2', 'rtk3', 'rtk3']);
		expect(messages.at(-1).freq).toBe(100);
		expect(messages.at(-1).profile).toBeUndefined();
		expect(messages.at(-1).stations.filter((station) => station.reference)).toHaveLength(3);
		stream.configure({ rtk: true, freq: 923.118, rtkProfile: 'rtk1' }, 1000000, 923.118);
		feed(mockRadioPayload());
		expect(messages.at(-1).profile).toBe('rtk1');
		expect(messages.at(-1).stations).toHaveLength(1);
		expect(messages.at(-1).status.scan).toBeUndefined();
		stream.reset();
	});
	it('reports invalid capture ranges and resets the inventory when disabled', () => {
		const messages = [],
			stream = new RtkStream(class {}, { buffer: new ArrayBuffer(65536) }, (message) => messages.push(message));
		stream.configure({ rtk: true, freq: 923.118, rtkProfile: 'scan' }, 1000000, 923.118);
		expect(messages.at(-1).status.state).toBe('error');
		expect(messages.at(-1).status.message).toContain('entire discovery range');
		stream.configure({ rtk: false, freq: 923.118, rtkProfile: 'scan' }, 1000000, 923.118);
		expect(messages.at(-1)).toMatchObject({ stations: [], status: { state: 'off' } });
	});
});
