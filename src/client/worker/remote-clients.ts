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

import type { VfoParams, RemoteClientState } from './types';
import { AUDIO_RATE } from './types';
import { POCSAGDecoder } from './pocsag';
import { ensureWasmInitialized, init } from './wasm-init';

import type { Backend } from './backend';
import { AUDIO_QUEUE_CAPACITY, appendAudio, mixLength } from './audio-queue';

// ── Remote-client VFO management (multi-client) ──────────────────────────
// Each connected client has its own independent set of VFOs. For each one
// the host spawns a dedicated DSP worker so the client can tune freely
// without affecting the host's or other clients' VFOs. Audio from each
// client's workers is mixed (respecting per-VFO volume) and sent back to
// that specific client via _remoteHostAudioCb(clientId, chunk).

export async function setRemoteHostCallback(this: Backend, callback: any): Promise<void> {
	this._remoteHostCb = callback;
}

export async function setRemoteHostFftCallback(this: Backend, callback: any): Promise<void> {
	this._remoteHostFftCb = callback;
}

export async function setRemoteHostAudioCallback(this: Backend, callback: any): Promise<void> {
	this._remoteHostAudioCb = callback;
}

export async function setRemoteHostStatsCallback(this: Backend, callback: any): Promise<void> {
	this._remoteHostStatsCb = callback;
}

export async function setRemoteHostPocsagCallback(this: Backend, callback: any): Promise<void> {
	this._remoteHostPocsagCb = callback;
}

export async function setRemoteHostRdsCallback(this: Backend, callback: any): Promise<void> {
	this._remoteHostRdsCb = callback;
}

export async function setRemoteHostRtl433Callback(this: Backend, callback: any): Promise<void> {
	this._remoteHostRtl433Cb = callback;
}

export async function setRemoteHostSquelchCallback(this: Backend, callback: any): Promise<void> {
	this._remoteHostSquelchCb = callback;
}

export function _ensureRemoteClients(this: Backend): void {
	if (!this._remoteClients) {
		this._remoteClients = new Map();
	}
}

export function _getOrCreateClientState(this: Backend, clientId: string): RemoteClientState {
	this._ensureRemoteClients();
	if (!this._remoteClients!.has(clientId)) {
		this._remoteClients!.set(clientId, {
			workers: [],
			params: [],
			audioQueues: [],
			mixBuf: null,
			pocsagDecoders: [],
			rdsDecoders: [],
			squelchOpen: []
		});
	}
	return this._remoteClients!.get(clientId)!;
}

export async function addRemoteClient(this: Backend, clientId: string): Promise<void> {
	this._getOrCreateClientState(clientId);
}

export function setRemoteSharedChannelization(this: Backend, clientId: string, enabled: boolean): void {
	const state = this._remoteClients?.get(clientId);
	if (state) state.sharedChannelization = enabled;
}

export async function removeRemoteClient(this: Backend, clientId: string): Promise<void> {
	this._ensureRemoteClients();
	const state = this._remoteClients!.get(clientId);
	if (!state) return;
	for (const w of state.workers) {
		if (w) { try { w.terminate(); } catch (_) {} }
	}
	this._remoteClients!.delete(clientId);
}

function bindRemoteWorker(backend: Backend, clientId: string, state: RemoteClientState, worker: Worker): void {
	worker.onmessage = (e: MessageEvent) => {
		// Removing a VFO shifts the indices; ignore messages from old workers
		// after removal, stream restart, or client disconnection.
		if (backend._remoteClients?.get(clientId) !== state) return;
		const index = state.workers.indexOf(worker);
		if (index === -1) return;
		const msg = e.data;
		if (msg.type === 'rtl433_event' || msg.type === 'rtl433_status') {
			const params = state.params[index];
			if (params && params.freq === msg.freq && (msg.type === 'rtl433_status' || params.rtl433)) {
				backend._remoteHostRtl433Cb?.(clientId, index, params.freq, msg);
			}
			return;
		}
		if (msg.type === 'rds') {
			const params = state.params[index];
			if (params?.rds && params.mode === 'wfm') {
				backend._remoteHostRdsCb?.(clientId, index, params.freq, msg.msg);
			}
		} else if (msg.type === 'audio') {
			const perf = state.perf ??= { audioCalls: 0, audioSamplesOut: 0, dspTimeSum: 0, dspTimeMax: 0, msgsSent: 0 };
			const elapsed = Number.isFinite(msg.dspTime) ? msg.dspTime : 0;
			const samples = msg.samples ? new Float32Array(msg.samples) : null;
			perf.audioCalls++;
			perf.dspTimeSum += elapsed;
			perf.dspTimeMax = Math.max(perf.dspTimeMax, elapsed);
			perf.audioSamplesOut += samples?.length ?? 0;
			if (backend._perf) {
				backend._perf.audioCalls++;
				backend._perf.dspTimeSum += elapsed;
				backend._perf.dspTimeMax = Math.max(backend._perf.dspTimeMax, elapsed);
				backend._perf.audioSamplesOut += samples?.length ?? 0;
			}
			const prev = state.squelchOpen[index] || false;
			const curr = !!msg.squelchOpen;
			state.squelchOpen[index] = curr;
			if (curr !== prev && backend._remoteHostSquelchCb) {
				backend._remoteHostSquelchCb(clientId, state.squelchOpen.slice());
			}
			if (samples) {
				backend._queueRemoteAudio(clientId, index, samples);
			}
		}
	};
}

export async function setRemoteVfoParams(this: Backend, clientId: string, index: number, params: VfoParams): Promise<void> {
	const state = this._getOrCreateClientState(clientId);
	const wasEnabled = state.params[index] && state.params[index]!.enabled;
	state.params[index] = params;

	if (state.audioQueues[index] && (!params.enabled || (params.enabled && !wasEnabled))) {
		state.audioQueues[index].len = 0;
	}

	if (!state.workers[index]) {
		if (!this._sampleRate || !this.sharedIqPools) return;
		const worker = new globalThis.Worker(new URL('../dsp-worker.ts', import.meta.url), { type: 'module' });
		bindRemoteWorker(this, clientId, state, worker);
		worker.postMessage({
			type: 'init',
			sampleRate: this._sampleRate,
			centerFreq: this._centerFreq,
			params: params,
			sabs: typeof SharedArrayBuffer !== 'undefined' ? this.sharedIqPools : null
		});
		state.workers[index] = worker;
		state.audioQueues[index] = { queue: new Float32Array(AUDIO_QUEUE_CAPACITY), len: 0 };
	} else {
		state.workers[index]!.postMessage({
			type: 'configure',
			params: params,
			centerFreq: this._centerFreq
		});
	}
}

export async function addRemoteVfo(this: Backend, clientId: string): Promise<void> {
	const state = this._getOrCreateClientState(clientId);
	const idx = state.workers.length;
	state.workers[idx] = null;
	state.params[idx]   = null;
	state.audioQueues[idx] = { queue: new Float32Array(AUDIO_QUEUE_CAPACITY), len: 0 };
}

export async function removeRemoteVfo(this: Backend, clientId: string, index: number): Promise<void> {
	const state = this._remoteClients && this._remoteClients.get(clientId);
	if (!state) return;
	const w = state.workers[index];
	if (w) { try { w.terminate(); } catch (_) {} }
	state.workers.splice(index, 1);
	state.params.splice(index, 1);
	state.audioQueues.splice(index, 1);
	state.pocsagDecoders.splice(index, 1);
	state.rdsDecoders.splice(index, 1);
	state.squelchOpen.splice(index, 1);
}

export function _queueRemoteAudio(this: Backend, clientId: string, index: number, samples: Float32Array): void {
	const state = this._remoteClients && this._remoteClients.get(clientId);
	if (!state) return;
	const entry = state.audioQueues[index];
	if (!entry) return;

	// Run POCSAG decoding on the raw audio before mixing
	const params = state.params[index];
	if (this._remoteHostPocsagCb && params && params.pocsag && params.mode === 'nfm') {
		if (!state.pocsagDecoders[index]) {
			state.pocsagDecoders[index] = new POCSAGDecoder(AUDIO_RATE, (pmsg: any) => {
				this._remoteHostPocsagCb(clientId, index, params.freq, pmsg);
			});
		}
		state.pocsagDecoders[index].process(samples);
	} else if (state.pocsagDecoders[index]) {
		state.pocsagDecoders[index] = null;
	}

	// Muted VFOs still decode metadata, but their audio must not accumulate.
	if (!params?.enabled) {
		entry.len = 0;
		return;
	}

	entry.len = appendAudio(entry.queue, entry.len, samples);
	this._mixAndEmitRemoteAudio(clientId);
}

export function _mixAndEmitRemoteAudio(this: Backend, clientId: string): void {
	if (!this._remoteHostAudioCb) return;
	const state = this._remoteClients && this._remoteClients.get(clientId);
	if (!state) return;
	const BATCH = 512;
	const active: { q: { queue: Float32Array; len: number }; p: VfoParams }[] = [];
	for (let i = 0; i < state.workers.length; i++) {
		const p = state.params[i];
		if (!p || !p.enabled) continue;
		const q = state.audioQueues[i];
		if (!q) continue;
		active.push({ q, p });
	}
	const minAvailable = mixLength(active.map(({ q }) => q.len));
	if (minAvailable < BATCH) return;
	if (!state.mixBuf || state.mixBuf.length < minAvailable) {
		state.mixBuf = new Float32Array(minAvailable + 1024);
	}
	const mixed = state.mixBuf;
	mixed.fill(0, 0, minAvailable);
	for (const { q, p } of active) {
		const vol = (p.audioMuted ? 0 : (p.volume ?? 50)) / 100;
		const vScale = vol * vol;
		const consumed = Math.min(minAvailable, q.len);
		for (let k = 0; k < consumed; k++) mixed[k] += q.queue[k] * vScale;
		const rem = q.len - consumed;
		if (rem > 0) q.queue.copyWithin(0, consumed, q.len);
		q.len = rem;
	}
	for (let k = 0; k < minAvailable; k++) {
		if (mixed[k] > 1) mixed[k] = 1;
		else if (mixed[k] < -1) mixed[k] = -1;
	}
	this._remoteHostAudioCb(clientId, mixed.slice(0, minAvailable));
	if (state.perf) state.perf.msgsSent++;
}

export function _reinitRemoteClientWorkers(this: Backend): void {
	if (!this._remoteClients) return;
	for (const [clientId, state] of this._remoteClients) {
		for (let i = 0; i < state.workers.length; i++) {
			const oldWorker = state.workers[i];
			if (!oldWorker && !state.params[i]) continue;
			try { oldWorker?.terminate(); } catch (_) {}

			const params = state.params[i];
			if (!params) { state.workers[i] = null; continue; }

			const worker = new globalThis.Worker(new URL('../dsp-worker.ts', import.meta.url), { type: 'module' });
			bindRemoteWorker(this, clientId, state, worker);
			worker.postMessage({
				type: 'init',
				sampleRate: this._sampleRate,
				centerFreq: this._centerFreq,
				params: params,
				sabs: typeof SharedArrayBuffer !== 'undefined' ? this.sharedIqPools : null
			});
			state.workers[i] = worker;
			state.audioQueues[i] = { queue: new Float32Array(AUDIO_QUEUE_CAPACITY), len: 0 };
		}
	}
}

export async function initRemoteClient(this: Backend): Promise<void> {
	await ensureWasmInitialized();
	this.wasm = await init();
	// Create a stub SdrDevice for the remote client — it receives IQ data
	// via WebRTC rather than USB, so all hardware methods are no-ops.
	const self = this;
	this.device = {
		deviceType: 'remote',
		sampleRates: [2000000, 4000000, 8000000, 10000000, 16000000, 20000000],
		gainControls: [],
		sampleFormat: 'int8',
		async open() {},
		async close() {},
		async getInfo() { return { name: 'Remote SDR' }; },
		async setSampleRate() {},
		async setFrequency() {},
		async setGain() {},
		async startRx(cb: any) { self._remoteClientCb = cb; },
		async stopRx() { self._remoteClientCb = null; },
	} as any;
}

export async function feedRemoteAudioChunk(this: Backend, chunk: any): Promise<void> {
	if (this._remoteClientAudioCb) {
		const floats = (chunk instanceof Float32Array)
			? chunk
			: new Float32Array(chunk instanceof ArrayBuffer ? chunk : chunk.buffer);
		this._remoteClientAudioCb(floats);

		// Feed whisper for local transcription on remote clients.
		// The audio arrives pre-mixed from the host, so attribute it to VFO 0.
		if (this._whisperEnabled && this._remoteClientWhisperCb && this.vfoParams && this.vfoParams[0]) {
			this._remoteClientWhisperCb(0, this.vfoParams[0].freq, floats);
		}
	}
}
