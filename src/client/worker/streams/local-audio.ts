import type { SamplesCallback, WhisperCallback, PocsagCallback } from '../runtime/callbacks';
import type { DspAudio } from '../runtime/dsp-messages';
import * as Comlink from 'comlink';

import { POCSAGDecoder } from '../decoders/pocsag';
import type { VfoParams, VfoState, PerfCounters } from '../runtime/types';
import { AUDIO_RATE } from '../runtime/types';
import type { Backend } from '../runtime/backend';

import { appendAudio, mixLength } from './audio-queue';
export function installWorkerAudioHandler(
	backend: Backend,
	_audioDebugCounter: number,
	perf: PerfCounters,
	whisperCallback: WhisperCallback | null,
	pushWhisper: (v: number, freq: number, samples: Float32Array) => void,
	pocsagCallback: PocsagCallback | null,
	pushAudio: (samples: Float32Array) => void,
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
			perf.audioSamplesOut += out.length;

			if (params.enabled) {
				state.audioQueueLen = appendAudio(state.audioQueue, state.audioQueueLen, out);

				if (backend._whisperEnabled && !params.pocsag && whisperCallback) {
					pushWhisper(v, params.freq, out);
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

export function mixLocalAudio(backend: Backend, pushAudio: (samples: Float32Array) => void) {
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
	while ((minAvailable = mixLength(activeStates.map((state) => state.audioQueueLen))) > 0) {
		if (!backend._mixBuf || backend._mixBuf.length < minAvailable) {
			backend._mixBuf = new Float32Array(minAvailable + 1024);
		}
		const mixed = backend._mixBuf;
		mixed.fill(0, 0, minAvailable);

		for (let i = 0; i < activeStates.length; i++) {
			const state = activeStates[i];
			const params = activeParams[i];
			const vol = params.audioMuted ? 0 : (params.volume ?? 50);
			const vScaling = (vol / 100) * (vol / 100);

			const source = state.audioQueue;
			const consumed = Math.min(minAvailable, state.audioQueueLen);
			for (let k = 0; k < consumed; k++) {
				mixed[k] += source[k] * vScaling;
			}

			const remaining = state.audioQueueLen - consumed;
			if (remaining > 0) {
				source.copyWithin(0, consumed, state.audioQueueLen);
			}
			state.audioQueueLen = remaining;
		}

		for (let k = 0; k < minAvailable; k++) {
			if (mixed[k] > 1.0) mixed[k] = 1.0;
			else if (mixed[k] < -1.0) mixed[k] = -1.0;
		}

		pushAudio(mixed.subarray(0, minAvailable));
	}
}

export function createAudioBatchers(
	backend: Backend,
	whisperCallback: WhisperCallback | null,
	perf: PerfCounters,
	audioCallback: SamplesCallback,
) {
	const AUDIO_BATCH_THRESHOLD = 2400; // 50ms at 48kHz
	const audioBatchBuf = new Float32Array(4800); // 100ms capacity
	let audioBatchPos = 0;

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
			audioCallback(Comlink.transfer(aCopy, [aCopy.buffer]));
			audioBatchPos = 0;
		}
	};

	const pushAudio = (samples: Float32Array): void => {
		let srcOff = 0;
		while (srcOff < samples.length) {
			const space = audioBatchBuf.length - audioBatchPos;
			const toCopy = Math.min(space, samples.length - srcOff);
			audioBatchBuf.set(samples.subarray(srcOff, srcOff + toCopy), audioBatchPos);
			audioBatchPos += toCopy;
			srcOff += toCopy;

			if (audioBatchPos >= AUDIO_BATCH_THRESHOLD) {
				flushAudio();
			}
		}
	};
	return { pushWhisper, pushAudio };
}
