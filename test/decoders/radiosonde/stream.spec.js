import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { RadiosondeStream } from '@/worker/decoders/radiosonde';
import * as dsp from '../../../wasm/dsp/pkg/browsdr_dsp.js';
import { frame, signal } from './fixtures';

const wasm = dsp.initSync({ module: readFileSync(new URL('../../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url)) });
describe('RS41 production channelizer', () => {
	it.each([
		[1000000, false],
		[5000000, false],
		[1000000, true],
		[5000000, true],
	])('decodes muted VFO at %s samples/s (float=%s)', (rate, float) => {
		const messages = [];
		const stream = new RadiosondeStream(dsp.DspProcessor, wasm.memory, (message) => messages.push(message));
		const params = { freq: 403, enabled: false, radiosonde: true };
		stream.configure(params, rate, 403.1);
		const iq = signal(frame(), rate, -100000);
		const ptr = dsp.alloc_float_buffer(131072 * 2);
		let time = performance.now();
		const clock = vi.spyOn(performance, 'now').mockImplementation(() => (time += 1000));
		for (let index = 0, chunk = 1; index < iq.length; index += 131072 * 2, chunk++) {
			const part = iq.subarray(index, index + 131072 * 2);
			if (float) new Float32Array(wasm.memory.buffer, ptr, part.length).set(part);
			else new Int8Array(wasm.memory.buffer, ptr, part.length).set(part.map((value) => Math.round(value * 127)));
			stream.process(ptr, part.length, float, chunk);
		}
		expect(messages.find((message) => message.status.frames > 0)?.sondes[0].id).toBe('V1234567');
		stream.configure({ ...params, radiosonde: false }, rate, 403.1);
		expect(messages.at(-1).status.state).toBe('off');
		clock.mockRestore();
		stream.reset();
	});
});
