import { installWorkerAudioHandler, createAudioBatchers } from './local-audio';
import { initializePerformanceReporting } from './performance';
import { dispatchIqChunk } from './channel-dispatch';
import { initializeVfoWorkers } from './vfo-workers';
import { configureReceiveGains, startUsbOnlyStream } from './usb-diagnostic';
import type {
	SamplesCallback,
	AudioCallback,
	WhisperCallback,
	PocsagCallback,
	RdsCallback,
	Rtl433Callback,
	AdsbCallback,
	AisCallback,
	DsdCallback,
} from '@/worker/runtime/callbacks.types';

/*
Copyright (c) 2026, jLynx <https://github.com/jLynx>

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
	Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
	Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the
	documentation and/or other materials provided with the distribution.
	Neither the name of Great Scott Gadgets nor the names of its contributors may be used to endorse or promote products derived from this software
	without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import * as Comlink from 'comlink';
import { FFT } from '@/worker/runtime/wasm-init';
import type { ChannelPlan } from './types';
import type { RxStreamOpts, VfoParams } from '@/worker/runtime/types';
import type { Backend } from '@/worker/runtime/backend';
import { displayToDeviceFrequencyHz } from '@/radio/frequency-shift';
import { spectrumSmoothingAlpha } from '@/display/spectrum-rate';

let _streamStarting = false;

export async function startRxStream(
	backend: Backend,
	opts: RxStreamOpts,
	spectrumCallback: SamplesCallback,
	audioCallback: AudioCallback,
	whisperCallback: WhisperCallback | null,
	pocsagCallback: PocsagCallback | null,
	rdsCallback: RdsCallback | null = null,
	dsdStatusCallback: DsdCallback | null = null,
	rtl433Callback: Rtl433Callback | null = null,
	adsbCallback: AdsbCallback | null = null,
	aisCallback: AisCallback | null = null,
): Promise<void> {
	if (_streamStarting) return;
	_streamStarting = true;
	const generation = (backend._streamGeneration = (backend._streamGeneration ?? 0) + 1);
	backend._remoteClientAudioCb = audioCallback; // Save reference for when chunk arrives
	backend._remoteClientWhisperCb = whisperCallback; // Save for remote client transcription
	try {
		const { device } = backend;
		if (!device) throw new Error('No device connected');
		const { centerFreq, frequencyShift = 0, sampleRate, fftSize, gains } = opts;

		await device.setSampleRate(sampleRate);
		await device.setFrequency(displayToDeviceFrequencyHz(centerFreq, frequencyShift));
		await configureReceiveGains(device, gains);
		if (import.meta.env.DEV && device.deviceType === 'limesdr' && gains?.['Receive Mode'] === 1) {
			await startUsbOnlyStream(backend, sampleRate);
			return;
		}

		// ── Spectrum FFT setup ────────────────────────────────────────
		const { spectrumFft, spectrumOutput } = initializeSpectrum(fftSize, backend);

		// Double buffer for Comlink zero-copy memory transfers
		let specFlip = new Float32Array(fftSize);
		let specFlop = new Float32Array(fftSize);
		let useFlip = true;

		const iqBuffer = new Int8Array(fftSize * 2);
		let iqBufferPos = 0;
		backend.setSpectrumFps(opts.spectrumFps ?? 20);
		backend._sharedChannelization = opts.sharedChannelization !== false;
		backend.setWhisperEnabled(opts.whisperEnabled === true);
		const channel = {
			worker: undefined as Worker | undefined,
			plan: undefined as ChannelPlan | undefined,
			targets: [] as Array<{ worker: Worker; params: VfoParams; shared: boolean }>,
			pending: 0,
			key: '',
			perf: { calls: 0, sum: 0, max: 0 },
		};
		backend._disposeChannelization?.();
		backend._disposeChannelization = () => {
			channel.worker?.terminate();
			channel.worker = undefined;
			channel.pending = 0;
		};
		let lastSpectrumTime = 0;

		// ── Audio DDC setup ───────────────────────────────────────────
		// Full SDR++ pipeline in Rust: NCO → polyphase resampler (→50kHz)
		// → channel FIR → squelch → FM demod → post-demod FIR → audio resampler (→48kHz)
		initializeVfoWorkers(backend, centerFreq, rtl433Callback, rdsCallback, dsdStatusCallback, sampleRate, adsbCallback, aisCallback);

		// ── DSP Performance Counters ──────────────────────────────────
		const perf = initializePerformanceReporting(backend, channel.perf, sampleRate);

		// ── Audio Batching Buffer ─────────────────────────────────────
		// Batch local PCM over at least 5ms to feed adaptive playback promptly.
		// Remote PCM uses larger batches to limit transport message overhead.
		const { pushWhisper, pushAudio } = createAudioBatchers(backend, whisperCallback, perf, audioCallback);

		// ── Audio Processing — helper processes a single VFO ──────────
		// Returns Float32Array of audio samples, or null if none produced
		let chunkCounter = 0;
		installWorkerAudioHandler(backend, 0, perf, whisperCallback, pushWhisper, pocsagCallback, pushAudio);

		// Apply initial gains BEFORE starting bulk reads to avoid
		// control transfer conflicts with in-flight bulk transfers.
		// Matches librtlsdr / SDR++ which configure everything before streaming.
		await device.startRx((data: ArrayBufferView) => {
			if (backend._streamGeneration !== generation) return;
			perf.usbCallbacks++;

			const signed = new Int8Array(data.buffer, data.byteOffset, data.byteLength);
			perf.lastChunkSize = signed.length;
			perf.inputSamplesSum += signed.length / 2;

			chunkCounter++;

			// Bulk copy for spectrum buffer
			({ iqBufferPos, lastSpectrumTime, useFlip, specFlip, specFlop } = processSpectrumChunk(
				signed,
				iqBuffer,
				iqBufferPos,
				lastSpectrumTime,
				backend,
				spectrumFft,
				spectrumOutput,
				useFlip,
				specFlip,
				specFlop,
				fftSize,
				spectrumCallback,
			));

			// Broadcast to DSP workers
			dispatchIqChunk(backend, sampleRate, centerFreq, channel, perf, signed, chunkCounter);
		});

		// Reinitialize all remote client DSP workers with the new sample rate
		// and shared IQ buffers. Without this, remote workers hold stale references
		// from the previous startRxStream and produce garbled audio.
		backend._reinitRemoteClientWorkers();
	} catch (e) {
		console.error('DEBUG CRASH IN STARTRXSTREAM:', e);
		throw e;
	} finally {
		_streamStarting = false;
	}
}

function initializeSpectrum(fftSize: number, backend: Backend) {
	const spectrumWindowFunc = (x: number): number => {
		const n = x * fftSize;
		const N = fftSize;
		const a0 = 0.355768;
		const a1 = 0.487396;
		const a2 = 0.144232;
		const a3 = 0.012604;
		return a0 - a1 * Math.cos((2.0 * Math.PI * n) / N) + a2 * Math.cos((4.0 * Math.PI * n) / N) - a3 * Math.cos((6.0 * Math.PI * n) / N);
	};
	const spectrumWindow = new Float32Array(fftSize);
	for (let i = 0; i < fftSize; i++) {
		spectrumWindow[i] = spectrumWindowFunc(i / fftSize);
	}
	const spectrumFft = new FFT(fftSize, spectrumWindow);
	backend._disposeSpectrum?.();
	backend._disposeSpectrum = () => spectrumFft.free();
	spectrumFft.set_smoothing_speed(0.6);
	const spectrumOutput = new Float32Array(fftSize);
	return { spectrumFft, spectrumOutput };
}

function processSpectrumChunk(
	signed: Int8Array<ArrayBufferLike>,
	iqBuffer: Int8Array<ArrayBuffer>,
	iqBufferPos: number,
	lastSpectrumTime: number,
	backend: Backend,
	spectrumFft: FFT,
	spectrumOutput: Float32Array<ArrayBuffer>,
	useFlip: boolean,
	specFlip: Float32Array<ArrayBuffer>,
	specFlop: Float32Array<ArrayBuffer>,
	fftSize: number,
	spectrumCallback: SamplesCallback,
) {
	{
		let srcOff = 0;
		while (srcOff < signed.length) {
			const space = iqBuffer.length - iqBufferPos;
			const toCopy = Math.min(space, signed.length - srcOff);
			iqBuffer.set(signed.subarray(srcOff, srcOff + toCopy), iqBufferPos);
			iqBufferPos += toCopy;
			srcOff += toCopy;
			if (iqBufferPos >= iqBuffer.length) {
				iqBufferPos = 0;
				const now = performance.now();
				if (now - lastSpectrumTime >= 1000 / backend._spectrumFps) {
					spectrumFft.set_smoothing_speed(spectrumSmoothingAlpha(lastSpectrumTime === 0 ? 50 : now - lastSpectrumTime));
					lastSpectrumTime = now;
					// Revert back to copy-based FFT for the spectrum waterfall
					// because `iqBuffer` batches data across USB chunk boundaries.
					spectrumFft.fft(iqBuffer, spectrumOutput);

					// Double buffer the output since Comlink.transfer neuters the buffer on this side.
					let specCopy = useFlip ? specFlip : specFlop;
					if (specCopy.length === 0) {
						// Was neutered by Comlink
						specCopy = new Float32Array(fftSize);
						if (useFlip) specFlip = specCopy;
						else specFlop = specCopy;
					}

					specCopy.set(spectrumOutput);
					useFlip = !useFlip;

					// Slice for remote BEFORE Comlink.transfer — transfer detaches specCopy.buffer,
					// making any subsequent .slice() throw "detached ArrayBuffer".
					if (backend._remoteHostFftCb) backend._remoteHostFftCb(specCopy.slice());
					if (spectrumCallback) spectrumCallback(Comlink.transfer(specCopy, [specCopy.buffer]));
				}
			}
		}
	}
	return { iqBufferPos, lastSpectrumTime, useFlip, specFlip, specFlop };
}
