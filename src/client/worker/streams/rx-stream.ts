import { installWorkerAudioHandler, createAudioBatchers } from './local-audio';
import { initializePerformanceReporting } from './performance';
import { dispatchIqChunk } from './channel-dispatch';
import { initializeVfoWorkers } from './vfo-workers';
import { configureReceiveGains, startUsbOnlyStream, isUsbOnlyReceive } from './usb-diagnostic';
import type {
	SamplesCallback,
	AudioCallback,
	WhisperCallback,
	PagerCallbacks,
	RdsCallback,
	RdsStatusCallback,
	Rtl433Callback,
	AdsbCallback,
	AisCallback,
	RadiosondeCallback,
	RtkCallback,
	BleCallback,
	AcarsCallback,
	AprsCallback,
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

import { SpectrumStream } from './spectrum-stream';
import type { ChannelPlan } from './types';
import type { RxStreamOpts, VfoParams } from '@/worker/runtime/types';
import type { Backend } from '@/worker/runtime/backend';
import { displayToDeviceFrequencyHz } from '@/radio/frequency-shift';

let _streamStarting = false;

export async function startRxStream(
	backend: Backend,
	opts: RxStreamOpts,
	spectrumCallback: SamplesCallback,
	audioCallback: AudioCallback,
	whisperCallback: WhisperCallback | null,
	pager: PagerCallbacks,
	rdsCallback: RdsCallback | null = null,
	rdsStatusCallback: RdsStatusCallback | null = null,
	dsdStatusCallback: DsdCallback | null = null,
	rtl433Callback: Rtl433Callback | null = null,
	adsbCallback: AdsbCallback | null = null,
	aisCallback: AisCallback | null = null,
	bleCallback: BleCallback | null = null,
	acarsCallback: AcarsCallback | null = null,
	radiosondeCallback: RadiosondeCallback | null = null,
	rtkCallback: RtkCallback | null = null,
	aprsCallback: AprsCallback | null = null,
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
		if (isUsbOnlyReceive(device, gains)) {
			return await startUsbOnlyStream(backend, sampleRate);
		}

		// ── Spectrum FFT setup ────────────────────────────────────────
		const spectrum = new SpectrumStream(backend, fftSize, spectrumCallback);
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
		installChannelCleanup(backend, channel);
		backend._replayPending = () => channel.pending > 0;

		// ── Audio DDC setup ───────────────────────────────────────────
		// Full SDR++ pipeline in Rust: NCO → polyphase resampler (→50kHz)
		// → channel FIR → squelch → FM demod → post-demod FIR → audio resampler (→48kHz)
		initializeWorkers(backend, opts, {
			rtl433Callback,
			rdsCallback,
			rdsStatusCallback,
			dsdStatusCallback,
			adsbCallback,
			aisCallback,
			bleCallback,
			acarsCallback,
			radiosondeCallback,
			rtkCallback,
			aprsCallback,
		});

		// ── DSP Performance Counters ──────────────────────────────────
		const perf = initializePerformanceReporting(backend, channel.perf, sampleRate);

		// ── Audio Batching Buffer ─────────────────────────────────────
		// Batch local PCM over at least 5ms to feed adaptive playback promptly.
		// Remote PCM uses larger batches to limit transport message overhead.
		const { pushWhisper, pushAudio } = createAudioBatchers(backend, whisperCallback, perf, audioCallback);

		// ── Audio Processing — helper processes a single VFO ──────────
		// Returns Float32Array of audio samples, or null if none produced
		let chunkCounter = 0;
		installWorkerAudioHandler(backend, 0, perf, whisperCallback, pushWhisper, pager, pushAudio);

		// Apply initial gains BEFORE starting bulk reads to avoid
		// control transfer conflicts with in-flight bulk transfers.
		// Matches librtlsdr / SDR++ which configure everything before streaming.
		await device.startRx((data: ArrayBufferView) => {
			if (backend._streamGeneration !== generation) return;
			if (skipRetuningInput(backend)) {
				chunkCounter++;
				return;
			}
			perf.usbCallbacks++;

			const signed = new Int8Array(data.buffer, data.byteOffset, data.byteLength);
			perf.lastChunkSize = signed.length;
			perf.inputSamplesSum += signed.length / 2;

			chunkCounter++;

			spectrum.push(signed);

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

function skipRetuningInput(backend: Backend): boolean {
	return backend._retuning || performance.now() < backend._settleUntil;
}

function initializeWorkers(
	backend: Backend,
	opts: RxStreamOpts,
	callbacks: {
		rtl433Callback: Rtl433Callback | null;
		rdsCallback: RdsCallback | null;
		rdsStatusCallback: RdsStatusCallback | null;
		dsdStatusCallback: DsdCallback | null;
		adsbCallback: AdsbCallback | null;
		aisCallback: AisCallback | null;
		bleCallback: BleCallback | null;
		acarsCallback: AcarsCallback | null;
		radiosondeCallback: RadiosondeCallback | null;
		rtkCallback: RtkCallback | null;
		aprsCallback?: AprsCallback | null;
	},
): void {
	initializeVfoWorkers(
		backend,
		opts.centerFreq,
		callbacks.rtl433Callback,
		callbacks.rdsCallback,
		callbacks.rdsStatusCallback,
		callbacks.dsdStatusCallback,
		opts.sampleRate,
		callbacks.adsbCallback,
		callbacks.aisCallback,
		callbacks.bleCallback,
		callbacks.acarsCallback,
		callbacks.radiosondeCallback,
		callbacks.rtkCallback,
		callbacks.aprsCallback,
	);
}

function installChannelCleanup(backend: Backend, channel: { worker?: Worker; pending: number }): void {
	backend._disposeChannelization?.();
	backend._disposeChannelization = () => {
		channel.worker?.terminate();
		channel.worker = undefined;
		channel.pending = 0;
	};
}
