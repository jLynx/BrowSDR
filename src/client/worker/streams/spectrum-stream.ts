import * as Comlink from 'comlink';
import { FFT } from '@/worker/runtime/wasm-init';
import type { Backend } from '@/worker/runtime/backend';
import type { SamplesCallback } from '@/worker/runtime/callbacks.types';
import { spectrumSmoothingAlpha, SpectrumFrameLimiter } from '@/display/spectrum-rate';

/** Keep a rolling FFT window so display cadence doesn't depend on filling a fresh window. */
export class SpectrumStream {
	private readonly fft: FFT;
	private readonly ring: Int8Array<ArrayBuffer>;
	private readonly input: Int8Array<ArrayBuffer>;
	private readonly output: Float32Array<ArrayBuffer>;
	private readonly limiter = new SpectrumFrameLimiter();
	private position = 0;
	private filled = 0;
	private lastTime: number | undefined;

	constructor(
		private readonly backend: Backend,
		fftSize: number,
		private readonly callback: SamplesCallback,
	) {
		this.fft = createSpectrumFft(fftSize);
		this.ring = new Int8Array(fftSize * 2);
		this.input = new Int8Array(fftSize * 2);
		this.output = new Float32Array(fftSize);
		backend._disposeSpectrum?.();
		backend._disposeSpectrum = () => this.fft.free();
	}

	push(samples: Int8Array<ArrayBufferLike>, now = performance.now()): void {
		if (!samples.length) return;
		this.append(samples);
		if (this.filled < this.ring.length || !this.limiter.shouldDraw(now, this.backend._spectrumFps)) return;

		// The next write position is the oldest sample once the ring is full.
		const tail = this.ring.subarray(this.position);
		this.input.set(tail);
		this.input.set(this.ring.subarray(0, this.position), tail.length);
		this.fft.set_smoothing_speed(spectrumSmoothingAlpha(this.lastTime === undefined ? 50 : now - this.lastTime));
		this.lastTime = now;
		this.fft.fft(this.input, this.output);

		const frame = this.output.slice();
		// Copy for remote consumers before Comlink detaches the local frame's buffer.
		if (this.backend._remoteHostFftCb) this.backend._remoteHostFftCb(frame.slice());
		if (this.callback) this.callback(Comlink.transfer(frame, [frame.buffer]));
	}

	private append(samples: Int8Array<ArrayBufferLike>): void {
		if (samples.length >= this.ring.length) {
			this.ring.set(samples.subarray(samples.length - this.ring.length));
			this.position = 0;
			this.filled = this.ring.length;
			return;
		}
		const count = Math.min(samples.length, this.ring.length - this.position);
		this.ring.set(samples.subarray(0, count), this.position);
		this.ring.set(samples.subarray(count), 0);
		this.position = (this.position + samples.length) % this.ring.length;
		this.filled = Math.min(this.ring.length, this.filled + samples.length);
	}
}

function createSpectrumFft(fftSize: number): FFT {
	const window = new Float32Array(fftSize);
	for (let i = 0; i < fftSize; i++) {
		const phase = (2 * Math.PI * i) / fftSize;
		window[i] = 0.355768 - 0.487396 * Math.cos(phase) + 0.144232 * Math.cos(2 * phase) - 0.012604 * Math.cos(3 * phase);
	}
	const fft = new FFT(fftSize, window);
	fft.set_smoothing_speed(0.6);
	return fft;
}
