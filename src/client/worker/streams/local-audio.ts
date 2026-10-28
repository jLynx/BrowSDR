import type { AudioCallback, WhisperCallback, PagerCallbacks } from '@/worker/runtime/callbacks.types';
import { downmix } from '@/audio/pcm';
import type { AudioChannels } from '@/audio/types';
import type { DspAudio } from '@/worker/runtime/dsp-messages.types';
import * as Comlink from 'comlink';
import { POCSAGDecoder } from '@/worker/decoders/pocsag';
import { GSCDecoder } from '@/worker/decoders/golay';
import { FlexDecoder } from '@/worker/decoders/flex/decoder';
import type { VfoParams, VfoState, PerfCounters } from '@/worker/runtime/types';
import type { PagerProtocol } from '@/worker/decoders/charsets';
import { AUDIO_RATE } from '@/worker/runtime/constants';
import type { Backend } from '@/worker/runtime/backend';
import { appendPcm, mixLength } from './audio-queue';

/** Whisper transcription runs on a VFO only when no pager protocol is decoding
 * it (pager audio is data, not speech). */
function shouldFeedWhisper(backend: Backend, params: VfoParams): boolean {
	return !!backend._whisperEnabled && !params.pocsag && !params.gsc && !params.flex;
}

/** Only main-channel audio may update the VFO's squelch and RX latch. */
function updateLocalSquelch(backend: Backend, state: VfoState, v: number, msg: DspAudio): void {
	if (msg.pager) return;
	state.squelchOpen = msg.squelchOpen;
	state.squelchDb = msg.squelchDb ?? -120;
	backend._latchedSquelchOpen ??= [];
	if (msg.squelchOpen) backend._latchedSquelchOpen[v] = true;
}

export function installWorkerAudioHandler(
	backend: Backend,
	_audioDebugCounter: number,
	perf: PerfCounters,
	whisperCallback: WhisperCallback | null,
	pushWhisper: (v: number, freq: number, samples: Float32Array) => void,
	pager: PagerCallbacks,
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

		updateLocalSquelch(backend, state, v, msg);
		if (msg.dspTime) {
			perf.dspTimeSum += msg.dspTime;
			if (msg.dspTime > perf.dspTimeMax) perf.dspTimeMax = msg.dspTime;
			perf.audioCalls++;
		}

		if (msg.samples) {
			const out = new Float32Array(msg.samples);
			const channels = msg.channels ?? 1;

			if (msg.pager) {
				// A pager-leg buffer: demodulated at the protocol's own RX
				// bandwidth, it feeds ONLY that decoder — never playback, whisper,
				// or the other pager decoders.
				decodeLocalPager(pager, params, state, v, out, msg.pager);
			} else {
				// Main VFO audio: playback + whisper only. Pager decode runs off
				// the tagged per-protocol legs above, not this shared buffer. The
				// untagged buffer still drives a teardown sweep so a decoder is
				// released when its protocol is disabled (no tagged buffer then
				// arrives to carry the teardown).
				perf.audioSamplesOut += out.length / channels;
				if (params.enabled) {
					queueLocalPcm(state, out, channels);
					if (whisperCallback && shouldFeedWhisper(backend, params)) {
						pushWhisper(v, params.freq, downmix(out, channels));
					}
				}
				decodeLocalPager(pager, params, state, v, out, undefined);
			}

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
	pager: PagerCallbacks,
	params: VfoParams,
	state: VfoState,
	v: number,
	out: Float32Array<ArrayBuffer>,
	tag: PagerProtocol | undefined,
) {
	// POCSAG, GSC and FLEX are peer pager protocols, each demodulated on its own
	// RX-bandwidth leg in the DSP worker and delivered as a tagged audio buffer.
	// `tag` names which leg this buffer belongs to; only that decoder processes
	// it. An untagged call (the main VFO buffer) carries no samples to decode and
	// is used only to run each branch's teardown when its protocol is disabled.
	decodeLocalPocsag(pager, params, state, v, out, tag);
	decodeLocalGsc(pager, params, state, v, out, tag);
	decodeLocalFlex(pager, params, state, v, out, tag);
}

/** POCSAG decode branch (a peer of the GSC and FLEX branches). */
function decodeLocalPocsag(
	pager: PagerCallbacks,
	params: VfoParams,
	state: VfoState,
	v: number,
	out: Float32Array<ArrayBuffer>,
	tag: PagerProtocol | undefined,
) {
	if (pager.pocsag && params.pocsag && params.mode === 'nfm' && tag === 'pocsag') {
		if (!state.pocsagDecoder) {
			state.pocsagDecoder = new POCSAGDecoder(
				AUDIO_RATE,
				(pmsg) => {
					pager.pocsag?.(v, params.freq, pmsg);
				},
				params.pocsagCharset,
			);
			state.pocsagCharset = params.pocsagCharset;
		} else if (params.pocsagCharset !== state.pocsagCharset) {
			// Live charset change -- re-point the decoder's codepage.
			if (params.pocsagCharset) state.pocsagDecoder.setCharset(params.pocsagCharset);
			state.pocsagCharset = params.pocsagCharset;
		}
		// Apply type-detection mode + second-guess option (cheap, idempotent).
		state.pocsagDecoder.setMode(params.pocsagMode ?? 'auto');
		state.pocsagDecoder.setShowSecondGuess(params.pocsagSecondGuess ?? false);
		state.pocsagDecoder.process(out);
		// Emit a throttled link-status snapshot (sync / baud / inversion / BER).
		if (pager.pocsagStatus) {
			const now = Date.now();
			if (state.pocsagStatusAt == null || now - state.pocsagStatusAt >= 500) {
				state.pocsagStatusAt = now;
				pager.pocsagStatus(v, params.freq, state.pocsagDecoder.getStatus());
			}
		}
	} else if (!params.pocsag && state.pocsagDecoder) {
		state.pocsagDecoder.reset();
		if (pager.pocsagStatus) pager.pocsagStatus(v, params.freq, state.pocsagDecoder.getStatus());
		state.pocsagDecoder = null;
		state.pocsagStatusAt = undefined;
	}
}

/** FLEX decode branch (separate so decodeLocalPager stays simple). */
function decodeLocalFlex(
	pager: PagerCallbacks,
	params: VfoParams,
	state: VfoState,
	v: number,
	out: Float32Array<ArrayBuffer>,
	tag: PagerProtocol | undefined,
) {
	if (pager.flex && params.flex && params.mode === 'nfm' && tag === 'flex') {
		if (!state.flexDecoder) {
			state.flexDecoder = new FlexDecoder(
				AUDIO_RATE,
				(fmsg) => {
					pager.flex?.(v, params.freq, fmsg);
				},
				params.flexCharset,
			);
			state.flexCharset = params.flexCharset;
		} else if (params.flexCharset !== state.flexCharset) {
			// Live charset change (e.g. ASCII <-> Kanji) re-points the decoder.
			if (params.flexCharset) state.flexDecoder.setCharset(params.flexCharset);
			state.flexCharset = params.flexCharset;
		}
		state.flexDecoder.process(out);
		if (pager.flexStatus) {
			const now = Date.now();
			if (state.flexStatusAt == null || now - state.flexStatusAt >= 500) {
				state.flexStatusAt = now;
				pager.flexStatus(v, params.freq, state.flexDecoder.getStatus());
			}
		}
	} else if (!params.flex && state.flexDecoder) {
		state.flexDecoder.reset();
		if (pager.flexStatus) pager.flexStatus(v, params.freq, state.flexDecoder.getStatus());
		state.flexDecoder = null;
		state.flexStatusAt = undefined;
	}
}

/** GSC decode branch (separate so decodeLocalPager stays simple). */
function decodeLocalGsc(
	pager: PagerCallbacks,
	params: VfoParams,
	state: VfoState,
	v: number,
	out: Float32Array<ArrayBuffer>,
	tag: PagerProtocol | undefined,
) {
	if (pager.gsc && params.gsc && params.mode === 'nfm' && tag === 'gsc') {
		if (!state.gscDecoder) {
			state.gscDecoder = new GSCDecoder(AUDIO_RATE, (gmsg) => {
				pager.gsc?.(v, params.freq, gmsg);
			});
		}
		state.gscDecoder.setShowSecondGuess(params.gscSecondGuess ?? false);
		state.gscDecoder.process(out);
		if (pager.gscStatus) {
			const now = Date.now();
			if (state.gscStatusAt == null || now - state.gscStatusAt >= 500) {
				state.gscStatusAt = now;
				pager.gscStatus(v, params.freq, state.gscDecoder.getStatus());
			}
		}
	} else if (!params.gsc && state.gscDecoder) {
		state.gscDecoder.reset();
		if (pager.gscStatus) pager.gscStatus(v, params.freq, state.gscDecoder.getStatus());
		state.gscDecoder = null;
		state.gscStatusAt = undefined;
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
