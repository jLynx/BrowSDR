import type { AudioCallback, WhisperCallback, PocsagCallback } from '@/worker/runtime/callbacks.types';
import { downmix } from '@/audio/pcm';
import type { AudioChannels } from '@/audio/types';
import type { DspAudio } from '@/worker/runtime/dsp-messages.types';
import * as Comlink from 'comlink';
import { POCSAGDecoder } from '@/worker/decoders/pocsag';
import type { VfoParams, VfoState, PerfCounters } from '@/worker/runtime/types';
import { AUDIO_RATE } from '@/worker/runtime/constants';
import type { Backend } from '@/worker/runtime/backend';
import { appendPcm, mixLength } from './audio-queue';
export function installWorkerAudioHandler(
	backend: Backend,
	_audioDebugCounter: number,
	perf: PerfCounters,
	whisperCallback: WhisperCallback | null,
	pushWhisper: (v: number, freq: number, samples: Float32Array) => void,
	pocsagCallback: PocsagCallback | null,
	pushAudio: AudioCallback,
) {
	const handleWorkerAudio = (v: number, msg: DspAudio): void => {
		const state = backend.vfoStates![v];
		const params = backend.vfoParams![v];
		if (!state || !params) {
			if (_audioDebugCounter++ % 200 === 0) {
				console.warn(
					`[handleWorkerAudio] VFO ${v} has no state/params (vfoParams.length=${backend.vfoParams?.length}, vfoStates.length=${backend.vfoStates?.length})`,
				);
			}
			return;
		}

		state.squelchOpen = msg.squelchOpen;
		state.squelchDb = msg.squelchDb ?? -120;
		if (!backend._latchedSquelchOpen) backend._latchedSquelchOpen = [];
		if (msg.squelchOpen) backend._latchedSquelchOpen[v] = true;
		if (msg.dspTime) {
			perf.dspTimeSum += msg.dspTime;
			if (msg.dspTime > perf.dspTimeMax) perf.dspTimeMax = msg.dspTime;
			perf.audioCalls++;
		}

		if (msg.samples) {
			const out = new Float32Array(msg.samples);
			const channels = msg.channels ?? 1;
			perf.audioSamplesOut += out.length / channels;

			if (params.enabled) {
				queueLocalPcm(state, out, channels);

				if (backend._whisperEnabled && !params.pocsag && whisperCallback) {
					pushWhisper(v, params.freq, downmix(out, channels));
				}
			}

			decodeLocalPager(pocsagCallback, params, state, v, out);

			// Clean up RDS decoder when disabled
			if ((!params.rds || params.mode !== 'wfm') && state.rdsDecoder) {
				state.rdsDecoder = null;
			}
		}

		// Mixer: flush all available audio immediately on every DSP callback.
		// Low-callback-rate devices (LimeSDR ~18/s) produce large audio bursts
		// that the main thread's ring buffer + schedule system smooths out.
		mixLocalAudio(backend, pushAudio);
	};
	// Expose for worker closure inside spawnWorker
	backend._handleWorkerAudio = handleWorkerAudio;
	return _audioDebugCounter;
}

function queueLocalPcm(state: VfoState, samples: Float32Array, channels: AudioChannels) {
	if (state.audioChannels !== channels) state.audioQueueLen = 0;
	state.audioChannels = channels;
	const queued = appendPcm(state.audioQueue, state.audioRightQueue, state.audioQueueLen, samples, channels);
	state.audioQueueLen = queued.length;
	state.audioRightQueue = queued.right;
}

export function decodeLocalPager(
	pocsagCallback: PocsagCallback | null,
	params: VfoParams,
	state: VfoState,
	v: number,
	out: Float32Array<ArrayBuffer>,
) {
	if (pocsagCallback && params.pocsag && params.mode === 'nfm') {
		if (!state.pocsagDecoder) {
			state.pocsagDecoder = new POCSAGDecoder(AUDIO_RATE, (pmsg) => {
				pocsagCallback(v, params.freq, pmsg);
			});
		}
		state.pocsagDecoder.process(out);
	} else if (!params.pocsag && state.pocsagDecoder) {
		state.pocsagDecoder = null;
	}
}

export function mixLocalAudio(backend: Backend, pushAudio: AudioCallback) {
	const activeStates: VfoState[] = [];
	const activeParams: VfoParams[] = [];

	for (let i = 0; i < backend.vfoParams!.length; i++) {
		const p = backend.vfoParams![i];
		const s = backend.vfoStates![i];
		if (s && p.enabled) {
			activeStates.push(s);
			activeParams.push(p);
		}
	}

	// Flush with no minimum threshold — let the main thread's audio ring
	// buffer handle the smoothing via _scheduleAudioChunk
	let minAvailable: number;
	const channels: AudioChannels = activeStates.some((state) => state.audioChannels === 2) ? 2 : 1;
	while ((minAvailable = mixLength(activeStates.map((state) => state.audioQueueLen))) > 0) {
		const values = minAvailable * channels;
		if (!backend._mixBuf || backend._mixBuf.length < values) {
			backend._mixBuf = new Float32Array(values + 1024);
		}
		const mixed = backend._mixBuf;
		mixed.fill(0, 0, values);

		for (let i = 0; i < activeStates.length; i++) {
			const state = activeStates[i];
			const params = activeParams[i];
			const vol = params.audioMuted ? 0 : (params.volume ?? 50);
			const vScaling = (vol / 100) * (vol / 100);

			const source = state.audioQueue;
			const consumed = Math.min(minAvailable, state.audioQueueLen);
			for (let k = 0; k < consumed; k++) {
				mixed[k * channels] += source[k] * vScaling;
				if (channels === 2) mixed[k * 2 + 1] += (state.audioChannels === 2 ? state.audioRightQueue![k] : source[k]) * vScaling;
			}

			const remaining = state.audioQueueLen - consumed;
			if (remaining > 0) {
				source.copyWithin(0, consumed, state.audioQueueLen);
				state.audioRightQueue?.copyWithin(0, consumed, state.audioQueueLen);
			}
			state.audioQueueLen = remaining;
		}

		for (let k = 0; k < values; k++) {
			if (mixed[k] > 1.0) mixed[k] = 1.0;
			else if (mixed[k] < -1.0) mixed[k] = -1.0;
		}

		pushAudio(mixed.subarray(0, values), channels);
	}
}

export function createAudioBatchers(
	backend: Backend,
	whisperCallback: WhisperCallback | null,
	perf: PerfCounters,
	audioCallback: AudioCallback,
) {
	const AUDIO_BATCH_THRESHOLD = 240; // Minimum 5ms; device bursts remain intact.
	const audioBatchBuf = new Float32Array(9600); // 100ms stereo capacity
	let audioBatchPos = 0;
	let audioChannels: AudioChannels = 1;

	// ── Per-VFO Whisper Batching ──────────────────────────────────
	// Each VFO gets its own batch buffer so Whisper receives isolated
	// (pre-mix, pre-volume) audio for accurate per-VFO transcription.
	const WHISPER_BATCH_THRESHOLD = 2400;
	const whisperBatchBufs: Float32Array[] = []; // Float32Array per VFO
	const whisperBatchPos: number[] = []; // write position per VFO
	backend._resetWhisperBatches = () => {
		whisperBatchBufs.length = 0;
		whisperBatchPos.length = 0;
	};
	const ensureWhisperBuf = (v: number): void => {
		if (!whisperBatchBufs[v]) {
			whisperBatchBufs[v] = new Float32Array(4800);
			whisperBatchPos[v] = 0;
		}
	};
	const pushWhisper = (v: number, freq: number, samples: Float32Array): void => {
		if (!backend._whisperEnabled || !whisperCallback) return;
		ensureWhisperBuf(v);
		let srcOff = 0;
		while (srcOff < samples.length) {
			const space = whisperBatchBufs[v].length - whisperBatchPos[v];
			const toCopy = Math.min(space, samples.length - srcOff);
			whisperBatchBufs[v].set(samples.subarray(srcOff, srcOff + toCopy), whisperBatchPos[v]);
			whisperBatchPos[v] += toCopy;
			srcOff += toCopy;
			if (whisperBatchPos[v] >= WHISPER_BATCH_THRESHOLD) {
				const wCopy = whisperBatchBufs[v].slice(0, whisperBatchPos[v]);
				perf.whisperMsgsSent = (perf.whisperMsgsSent ?? 0) + 1;
				whisperCallback(v, freq, Comlink.transfer(wCopy, [wCopy.buffer]));
				whisperBatchPos[v] = 0;
			}
		}
	};

	const flushAudio = (): void => {
		if (audioBatchPos > 0) {
			perf.msgsSent++;
			const aCopy = audioBatchBuf.slice(0, audioBatchPos);
			audioCallback(Comlink.transfer(aCopy, [aCopy.buffer]), audioChannels);
			audioBatchPos = 0;
		}
	};

	const pushAudio: AudioCallback = (samples, channels = 1): void => {
		if (channels !== audioChannels) {
			flushAudio();
			audioChannels = channels;
		}
		let srcOff = 0;
		while (srcOff < samples.length) {
			const space = 4800 * channels - audioBatchPos;
			const toCopy = Math.min(space, samples.length - srcOff);
			audioBatchBuf.set(samples.subarray(srcOff, srcOff + toCopy), audioBatchPos);
			audioBatchPos += toCopy;
			srcOff += toCopy;

			if (audioBatchPos >= AUDIO_BATCH_THRESHOLD * channels) {
				flushAudio();
			}
		}
	};
	return { pushWhisper, pushAudio };
}
