import { describe, expect, it, vi } from 'vitest';
import { HighResolutionWaterfall } from '@/display/waterfall-gl';
import { createWaterfallLayout, encodeWaterfallLine, WATERFALL_DB_MIN, WATERFALL_DB_SPAN } from '@/display/waterfall-history';

function encodedLine(input) {
	const layout = createWaterfallLayout(input.length, 4096, 512);
	const values = new Float32Array(layout.width * layout.tiles);
	const bytes = new Uint8Array(values.length * 2);
	encodeWaterfallLine(input, layout.levels, values, bytes);
	const read = (index) => WATERFALL_DB_MIN + (((bytes[index * 2] << 8) | bytes[index * 2 + 1]) / 65535) * WATERFALL_DB_SPAN;
	return { layout, values, read };
}

describe('full-resolution waterfall history', () => {
	it.each([4096, 8192, 16384])('retains all 65536 bins within a %i-pixel texture limit', (limit) => {
		const layout = createWaterfallLayout(65536, limit, 512);
		expect(layout.levels[0]).toEqual({ offset: 0, bins: 65536, scale: 1 });
		expect(layout.width).toBeLessThanOrEqual(limit);
		expect(layout.height).toBeLessThanOrEqual(limit);
		expect(layout.width * layout.height * 2).toBeLessThanOrEqual(104 * 1024 * 1024);
		expect(layout.history).toBeGreaterThan(100);
	});

	it('keeps neighbouring narrow signals separate, including across texture tile boundaries', () => {
		const input = new Float32Array(65536).fill(-120);
		input[4095] = -60;
		input[4097] = -65;
		input[60000] = -40;
		const { read } = encodedLine(input);
		expect(read(4095)).toBeCloseTo(-60, 2);
		expect(read(4096)).toBeCloseTo(-120, 2);
		expect(read(4097)).toBeCloseTo(-65, 2);
		expect(read(60000)).toBeCloseTo(-40, 2);
	});

	it('preserves narrow peaks at every overview level and handles incomplete groups', () => {
		const { layout, values } = encodedLine([-120, -40, -100, -90, -50]);
		expect(Array.from(values.slice(layout.levels[1].offset, layout.levels[1].offset + 2))).toEqual([-40, -50]);
		expect(values[layout.levels[2].offset]).toBe(-40);
	});

	it('stores dB independently of display contrast with less than 0.004 dB quantization', () => {
		const input = [-150, -118.1648, -100.123, -48.1648, 0, 40];
		const { read } = encodedLine(input);
		input.forEach((power, index) => expect(Math.abs(read(index) - power)).toBeLessThan(0.004));
	});

	it('keeps a separate preview slot and wraps without overwriting the newest committed row', () => {
		const layout = createWaterfallLayout(16, 4096, 3);
		const engine = Object.create(HighResolutionWaterfall.prototype);
		const upload = vi.fn();
		Object.assign(engine, {
			layout,
			historySize: 3,
			current: 3,
			validRows: 3,
			values: new Float32Array(layout.width * layout.tiles),
			bytes: new Uint8Array(layout.width * layout.tiles * 2),
			gl: { activeTexture: vi.fn(), bindTexture: vi.fn(), texSubImage2D: upload },
			render: vi.fn(),
		});
		engine.renderLine(new Float32Array(16).fill(-90), 2, 0.25);
		expect(upload.mock.calls.map((call) => call[3] / layout.tiles)).toEqual([3, 0, 1]);
		expect(engine.current).toBe(1);
		engine.renderLine(new Float32Array(16).fill(-80), 0, 0.5);
		expect(engine.current).toBe(1);
		expect(upload.mock.calls.at(-1)[3]).toBe(layout.tiles);
		engine.setZoom(0.75, 20);
		expect(upload).toHaveBeenCalledTimes(4);
	});
});
