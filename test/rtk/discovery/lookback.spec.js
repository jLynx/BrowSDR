import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { initSync, DspProcessor, alloc_iq_buffer, free_iq_buffer } from '../../../wasm/dsp/pkg/browsdr_dsp.js';
import { RtkStream } from '@/worker/decoders/rtk/stream';
import { mockRtkIq } from '../../fixtures/rtk/mock-iq';
import { mockRtk3Beacon, mockRtk3Options } from '../../fixtures/rtk/mock-rtk3';

describe('RTK spectrum-triggered acquisition with browser WASM', () => {
	it.each(['rtk1', 'rtk3'])('recovers %s sent before its hint and leaves the sweep running', (profile) => {
		const wasm = initSync({ module: readFileSync(new URL('../../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url)) }),
			ptr = alloc_iq_buffer(8192),
			messages = [],
			stream = new RtkStream(DspProcessor, wasm.memory, (message) => messages.push(message));
		stream.configure({ rtk: true, freq: 100, rtkProfile: 'scan', rtkScanStart: 919.4, rtkScanEnd: 920.6 }, 2000000, 920);
		let chunk = 0;
		const feed = (iq) => {
			for (let at = 0; at < iq.length; at += 8192) {
				const part = iq.subarray(at, at + 8192);
				new Uint8Array(wasm.memory.buffer, ptr, part.length).set(part);
				stream.process(ptr, part.length, false, ++chunk);
				expect([...new Uint8Array(wasm.memory.buffer, ptr, part.length)]).toEqual([...part]);
			}
			stream.emit();
		};
		try {
			const packet =
				profile === 'rtk1'
					? mockRtkIq(undefined, { oversample: 4 })
					: mockRtkIq(mockRtk3Beacon(4242, 100, 100).data, { ...mockRtk3Options, oversample: 8 });
			feed(packet);
			expect(messages.at(-1).status.packets).toBe(0);
			stream.offerCandidates([920], 2000000, 920);
			feed(new Uint8Array(1400000));
			expect(messages.at(-1).status.packets).toBe(1);
			expect(messages.at(-1).stations).toHaveLength(profile === 'rtk1' ? 0 : 1);
			feed(packet);
			expect(messages.at(-1).stations).toHaveLength(1);
			expect(messages.at(-1).stations[0].discovery.profile).toBe(profile);
			if (profile === 'rtk1') expect(messages.at(-1).stations[0].reference).toBeDefined();
			expect(messages.at(-1).status.scan).toMatchObject({ frequencyMHz: 919.4, activityFrequenciesMHz: [920] });
		} finally {
			stream.reset();
			free_iq_buffer(ptr, 8192);
		}
	});
});
