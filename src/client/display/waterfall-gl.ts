import { convertDecibelToRGB } from './utils';
import { DEFAULT_SPECTRUM_RANGE } from './spectrum-range';
import { createWaterfallLayout, encodeWaterfallLine } from './waterfall-history';
import { waterfallFragmentShader, waterfallVertexShader } from './waterfall-shaders';

/** Tiled, 16-bit dB history. Zoom only selects a peak-preserving GPU level. */
export class HighResolutionWaterfall {
	readonly gl: WebGLRenderingContext;
	readonly layout: ReturnType<typeof createWaterfallLayout>;
	readonly historySize: number;
	private readonly history: WebGLTexture;
	private readonly palette: WebGLTexture;
	private readonly program: WebGLProgram;
	private readonly vertices: WebGLBuffer;
	private readonly values: Float32Array;
	private readonly bytes: Uint8Array;
	private current = 0;
	private fraction = 0;
	private offset = 0;
	private zoom = 1;
	private validRows = 0;

	constructor(
		readonly canvas: HTMLCanvasElement,
		readonly bandSize: number,
		historySize: number,
	) {
		const gl = canvas.getContext('webgl');
		if (!gl) throw new Error('High-resolution waterfall requires WebGL');
		this.gl = gl;
		if (!gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision) {
			throw new Error('High-resolution waterfall requires high precision fragment shaders');
		}
		this.layout = createWaterfallLayout(bandSize, Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)), historySize);
		this.historySize = this.layout.history;
		this.values = new Float32Array(this.layout.width * this.layout.tiles);
		this.bytes = new Uint8Array(this.values.length * 2);
		this.program = createProgram(gl);
		this.history = createTexture(gl, gl.TEXTURE0);
		gl.disable(gl.BLEND);
		gl.disable(gl.DEPTH_TEST);
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(
			gl.TEXTURE_2D,
			0,
			gl.LUMINANCE_ALPHA,
			this.layout.width,
			this.layout.height,
			0,
			gl.LUMINANCE_ALPHA,
			gl.UNSIGNED_BYTE,
			null,
		);
		if (gl.getError() !== gl.NO_ERROR) {
			gl.deleteTexture(this.history);
			gl.deleteProgram(this.program);
			throw new Error('Unable to allocate full-resolution waterfall history');
		}
		this.palette = createTexture(gl, gl.TEXTURE1);
		const colours = new Uint8Array(256 * 4);
		for (let i = 0; i < 256; i++) {
			const { r, g, b } = convertDecibelToRGB(i / 255, 0, 1);
			colours.set([r, g, b, 255], i * 4);
		}
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, colours);
		this.vertices = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
		const position = gl.getAttribLocation(this.program, 'position');
		gl.enableVertexAttribArray(position);
		gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
		gl.uniform1i(gl.getUniformLocation(this.program, 'history'), 0);
		gl.uniform1i(gl.getUniformLocation(this.program, 'palette'), 1);
		gl.uniform2f(gl.getUniformLocation(this.program, 'textureSize'), this.layout.width, this.layout.height);
		this.uniform('tiles', this.layout.tiles);
		this.uniform('slots', this.historySize + 1);
		this.uniform('rows', this.historySize);
		this.uniform('bins', bandSize);
		this.setRange(DEFAULT_SPECTRUM_RANGE.minDB, DEFAULT_SPECTRUM_RANGE.maxDB);
		this.render();
	}

	setRange(minDB: number, maxDB: number) {
		this.gl.uniform2f(this.gl.getUniformLocation(this.program, 'range'), minDB, maxDB);
	}

	setZoom(offset: number, scale: number) {
		this.offset = offset;
		this.zoom = scale;
	}

	render() {
		const { gl, canvas } = this;
		const dpr = window.devicePixelRatio || 1;
		const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
		const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
		if (canvas.width !== width || canvas.height !== height) {
			canvas.width = width;
			canvas.height = height;
		}
		gl.viewport(0, 0, width, height);
		gl.uniform2f(gl.getUniformLocation(this.program, 'viewport'), width, height);
		const footprint = this.bandSize / this.zoom / width;
		let level = this.layout.levels[0];
		for (const candidate of this.layout.levels) {
			if (candidate.scale > Math.max(1, footprint)) break;
			level = candidate;
		}
		this.uniform('levelOffset', level.offset);
		this.uniform('levelBins', level.bins);
		this.uniform('levelScale', level.scale);
		this.uniform('offset', this.offset);
		this.uniform('zoom', this.zoom);
		this.uniform('current', this.current);
		this.uniform('fraction', this.fraction);
		this.uniform('validRows', this.validRows);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	renderLine(input: Float32Array | number[], rows = 1, fraction = 0) {
		encodeWaterfallLine(input, this.layout.levels, this.values, this.bytes);
		const { gl, layout } = this;
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.history);
		for (let row = 0; row <= Math.min(rows, this.historySize); row++) {
			gl.texSubImage2D(
				gl.TEXTURE_2D,
				0,
				0,
				this.current * layout.tiles,
				layout.width,
				layout.tiles,
				gl.LUMINANCE_ALPHA,
				gl.UNSIGNED_BYTE,
				this.bytes,
			);
			if (row < Math.min(rows, this.historySize)) this.current = (this.current + 1) % (this.historySize + 1);
		}
		this.fraction = fraction;
		this.validRows = Math.min(this.historySize, this.validRows + rows);
		this.render();
	}

	destroy() {
		this.gl.deleteTexture(this.history);
		this.gl.deleteTexture(this.palette);
		this.gl.deleteBuffer(this.vertices);
		this.gl.deleteProgram(this.program);
	}

	private uniform(name: string, value: number) {
		this.gl.uniform1f(this.gl.getUniformLocation(this.program, name), value);
	}
}

function createTexture(gl: WebGLRenderingContext, unit: number) {
	const texture = gl.createTexture();
	gl.activeTexture(unit);
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	return texture;
}

function createProgram(gl: WebGLRenderingContext) {
	const program = gl.createProgram();
	const shaders = [
		[gl.VERTEX_SHADER, waterfallVertexShader],
		[gl.FRAGMENT_SHADER, waterfallFragmentShader],
	] as const;
	for (const [type, source] of shaders) {
		const shader = gl.createShader(type)!;
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			const message = gl.getShaderInfoLog(shader) || 'Unable to compile waterfall shader';
			gl.deleteShader(shader);
			gl.deleteProgram(program);
			throw new Error(message);
		}
		gl.attachShader(program, shader);
		gl.deleteShader(shader);
	}
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		const message = gl.getProgramInfoLog(program) || 'Unable to link waterfall shaders';
		gl.deleteProgram(program);
		throw new Error(message);
	}
	gl.useProgram(program);
	return program;
}
