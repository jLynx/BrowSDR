import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { initSync, DspProcessor, alloc_iq_buffer, free_iq_buffer } from '../../../wasm/dsp/pkg/browsdr_dsp.js';
import { RtkStream } from '@/worker/decoders/rtk/stream';
import { mockRtkIq } from '../../fixtures/rtk/mock-iq';
import { mockRtk2Packet, mockRtk2Compact, mockRtk2Options } from '../../fixtures/rtk/mock-rtk2';
import { mockRtk3Beacon, mockRtk3Packet, mockRtk3Container, mockRtk3Options, mockRtcmReference } from '../../fixtures/rtk/mock-rtk3';

const wasm = initSync({ module: readFileSync(new URL('../../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url)) });
const networkSource = 'rtk2-544553544e455431-4242';
function receiver(rate, frequency, center, floats, source = '') {
	const capacity = 65536,
		bytes = capacity * (floats ? 4 : 1),
		ptr = alloc_iq_buffer(bytes),
		messages = [];
	const stream = new RtkStream(DspProcessor, wasm.memory, (message) => messages.push(message));
	stream.configure({ rtk: true, rtkProfile: 'auto', freq: frequency, rtkFollowSource: source }, rate, center);
	let valuesRead = 0,
		chunk = 0;
	const feed = (iq) => {
		for (let at = 0; at < iq.length; at += capacity) {
			const part = iq.subarray(at, at + capacity);
			if (floats) new Float32Array(wasm.memory.buffer, ptr, part.length).set(Float32Array.from(part, (value) => value / 128));
			else new Int8Array(wasm.memory.buffer, ptr, part.length).set(part);
			stream.process(ptr, part.length, floats, ++chunk);
			valuesRead += part.length;
		}
		stream.emit();
	};
	return {
		messages,
		packet(packet, options, channel = frequency) {
			const iq = new Int8Array(mockRtkIq(packet.data, { ...options, oversample: rate / 250000 }).buffer);
			const shift = channel - center;
			if (shift)
				for (let i = 0; i < iq.length; i += 2) {
					const phase = (Math.PI * shift * 1e6 * i) / rate,
						c = Math.cos(phase),
						s = Math.sin(phase),
						re = iq[i],
						im = iq[i + 1];
					iq[i] = Math.round(re * c - im * s);
					iq[i + 1] = Math.round(re * s + im * c);
				}
			feed(iq);
			// Let the real DDC filter delay and final LoRa symbol drain at wide input rates.
			feed(new Int8Array(Math.round(rate * 0.005) * 2));
		},
		until(seconds) {
			feed(new Int8Array(Math.max(0, Math.round(seconds * rate) * 2 - valuesRead)));
		},
		free() {
			stream.reset();
			free_iq_buffer(ptr, bytes);
		},
	};
}

// Each case pushes up to 0.8 s of 20 MSPS IQ through WASM: about 3 s locally, over 6 s on CI runners.
describe('250 kHz Auto acquisition and promotion with browser WASM', { timeout: 30_000 }, () => {
	it.each([
		['container', false, ''],
		['container', true, networkSource],
		['compact', false, networkSource],
		['compact', true, ''],
		['rtk3', false, ''],
		['rtk3', true, 'rtk3-100-4242'],
	])('keeps decoding %s after promotion (float: %s, source: %s)', (format, floats, source) => {
		const test = receiver(2000000, 920, 920, floats, source);
		try {
			for (let sequence = 1; sequence <= 3; sequence++) {
				const packet =
					format === 'rtk3'
						? mockRtk3Packet(mockRtk3Container(undefined, sequence), 4242, 100)
						: format === 'compact'
							? mockRtk2Compact(mockRtcmReference(), sequence)
							: mockRtk2Packet(mockRtcmReference(), sequence);
				test.packet(packet, format === 'rtk3' ? mockRtk3Options : mockRtk2Options);
			}
			expect(test.messages.at(-1).status).toMatchObject({ state: 'receiving', detectedProfile: format === 'rtk3' ? 'rtk3' : 'rtk2' });
			expect(test.messages.at(-1).stations).toHaveLength(1);
			expect(test.messages.flatMap((message) => message.rtcm).map((frame) => frame.type)).toEqual([1006, 1006, 1006]);
		} finally {
			test.free();
		}
	});
	it.each([false, true])('preserves beacon sample times and follows RTK3 after promotion (float: %s)', (floats) => {
		const test = receiver(20000000, 915.401, 921.5, floats, 'rtk3-100-4242');
		try {
			test.until(0.1);
			test.packet(mockRtk3Beacon(4242, 100, 100), mockRtk3Options);
			expect(test.messages.at(-1).status.hopDecision).toBe('checking');
			test.until(0.7);
			test.packet(mockRtk3Beacon(4242, 700, 100), mockRtk3Options, 915.901);
			expect(test.messages.at(-1).status).toMatchObject({ hopDecision: 'following', hopTracking: true });
			test.until(0.8);
			test.packet(mockRtk3Packet(mockRtk3Container(), 4242, 100), mockRtk3Options, 915.901);
			expect(test.messages.flatMap((message) => message.rtcm).map((frame) => frame.type)).toEqual([1006]);
		} finally {
			test.free();
		}
	});
});
