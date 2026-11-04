import { describe, expect, it } from 'vitest';
import { RtkIqHistory } from '@/worker/decoders/rtk/discovery/history';

describe('RTK full-band lookback', () => {
	it.each([false, true])('replays wrapped IQ in sample order and preserves the live input (floats: %s)', (floats) => {
		const memory = { buffer: new ArrayBuffer(256) },
			View = floats ? Float32Array : Int8Array,
			history = new RtkIqHistory(memory, 0.5, 32);
		const append = (values) => {
			new View(memory.buffer).set(values);
			history.append(0, values.length, floats, 8);
		};
		append([1, -1, 2, -2, 3, -3]);
		append([4, -4, 5, -5, 6, -6]);
		new View(memory.buffer).set([99, -99, 98, -98]);
		const decoded = [];
		history.replay(0, 4, floats, (ptr, values) => decoded.push(...new View(memory.buffer, ptr, values)));
		expect(decoded).toEqual([3, -3, 4, -4, 5, -5, 6, -6]);
		expect([...new View(memory.buffer, 0, 4)]).toEqual([99, -99, 98, -98]);
		expect(history.duration).toBe(0.5);
	});
	it('restores live IQ even when the decoder grows WASM memory and then fails', () => {
		const memory = { buffer: new ArrayBuffer(16) },
			history = new RtkIqHistory(memory);
		new Int8Array(memory.buffer).set([1, 2, 3, 4]);
		history.append(0, 4, false, 8);
		new Int8Array(memory.buffer).set([5, 6, 7, 8]);
		expect(() =>
			history.replay(0, 4, false, () => {
				memory.buffer = new ArrayBuffer(32);
				throw Error('Decoder failed');
			}),
		).toThrow('Decoder failed');
		expect([...new Int8Array(memory.buffer, 0, 4)]).toEqual([5, 6, 7, 8]);
	});
	it('bounds memory and discards history across format/rate changes, gaps and reset', () => {
		const memory = { buffer: new ArrayBuffer(256) },
			history = new RtkIqHistory(memory, 1, 16);
		new Int8Array(memory.buffer).set(Array.from({ length: 32 }, (_, i) => i));
		history.append(0, 32, false, 100);
		const generation = history.generation;
		expect(history.byteLength).toBe(16);
		expect(history.duration).toBe(0.08);
		const decoded = [];
		history.replay(0, 8, false, (ptr, values) => decoded.push(...new Int8Array(memory.buffer, ptr, values)));
		expect(decoded).toEqual(Array.from({ length: 16 }, (_, i) => i + 16));
		new Float32Array(memory.buffer).set([0.25, -0.5]);
		history.append(0, 2, true, 20);
		expect(history.generation).toBeGreaterThan(generation);
		expect(history.duration).toBe(0.05);
		history.clear();
		expect(history.duration).toBe(0);
		history.reset();
		expect(history.byteLength).toBe(0);
	});
});
