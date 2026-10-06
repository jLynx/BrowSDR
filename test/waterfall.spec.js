import { describe, expect, it, vi } from 'vitest';
import { Waterfall, WaterfallGL } from '../src/client/utils';

function createGlEngine(current = 0) {
	const engine = Object.create(WaterfallGL.prototype);
	Object.assign(engine, {
		bandSize: 2, historySize: 512, data: new Uint8Array(8),
		minDB: -70, maxDB: 0, _current: current, scrollFraction: 0,
		textures: ['new', 'old'], shaderProgram: {},
		gl: {
			texSubImage2D: vi.fn(), activeTexture: vi.fn(), bindTexture: vi.fn(),
			uniform1i: vi.fn(), uniform1f: vi.fn(), getUniformLocation: () => 'offset', drawArrays: vi.fn(),
		},
	});
	return engine;
}

describe('time-based waterfall rendering', () => {
	it('updates the preview and fractional position without committing a row', () => {
		const engine = createGlEngine(10);
		engine.renderLine([-50, -40], 0, 0.5);
		expect(engine._current).toBe(10);
		expect(engine.gl.texSubImage2D).toHaveBeenCalledTimes(1);
		expect(engine.gl.uniform1f).toHaveBeenLastCalledWith('offset', 10.5);
	});
	it('rotates textures correctly when timed rows cross a history boundary', () => {
		const engine = createGlEngine(511);
		engine.renderLine([-50, -40], 2, 0.25);
		expect(engine._current).toBe(1);
		expect(engine.textures).toEqual(['old', 'new']);
		expect(engine.gl.texSubImage2D.mock.calls.map(call => call[3])).toEqual([511, 0, 1]);
		expect(engine.gl.uniform1f).toHaveBeenLastCalledWith('offset', 1.25);
	});
	it('keeps the default one-row API compatible', () => {
		const engine = createGlEngine();
		engine.renderLine([-50, -40]);
		expect(engine._current).toBe(1);
		expect(engine.gl.uniform1f).toHaveBeenLastCalledWith('offset', 1);
	});
	it('uses fractional scrolling and timed row commits in the Canvas fallback', () => {
		const engine = Object.create(Waterfall.prototype);
		const offCtx = {
			drawImage: vi.fn(), getImageData: () => ({ data: new Uint8Array(8) }), putImageData: vi.fn(),
		};
		const previewCtx = { putImageData: vi.fn() };
		Object.assign(engine, {
			canvas: { width: 2, height: 512 }, ctx: { fillRect: vi.fn(), drawImage: vi.fn() },
			offscreen: { width: 2, height: 512 }, offCtx, preview: { getContext: () => previewCtx },
			minDB: -70, maxDB: 0, zoomOffset: 0, zoomScale: 1,
		});
		engine.renderLine([-50, -40], 0, 0.5);
		expect(offCtx.drawImage).not.toHaveBeenCalled();
		expect(offCtx.putImageData).not.toHaveBeenCalled();
		expect(engine.ctx.drawImage.mock.calls[0].slice(5)).toEqual([0, 0.5, 2, 511.5]);
		engine.renderLine([-50, -40], 2, 0);
		expect(offCtx.drawImage.mock.calls[0].slice(5)).toEqual([0, 2, 2, 510]);
		expect(offCtx.putImageData).toHaveBeenCalledTimes(2);
	});
});
