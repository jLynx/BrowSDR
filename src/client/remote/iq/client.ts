import type { Backend } from '@/worker/runtime/backend';
import type { VfoParams } from '@/worker/runtime/types';
import { unpackIqPacket } from './packet';
import { ensureWasmInitialized, init } from '@/worker/runtime/wasm-init';

export async function initRemoteClient(this: Backend): Promise<void> {
	await ensureWasmInitialized();
	this.wasm = await init();
	this._remoteIqEnabled = false;
	this._remoteIqSequences.clear();
	this._remoteIqRevisions = [];
	// Keep the usual worker lifecycle while WebRTC supplies spectrum and IQ/audio.
	this.device = {
		deviceType: 'remote',
		sampleRates: [2000000, 4000000, 8000000, 10000000, 16000000, 20000000],
		gainControls: [],
		sampleFormat: 'int8',
		open: () => Promise.resolve(),
		close: () => Promise.resolve(),
		getInfo: () => Promise.resolve({ name: 'Remote SDR' }),
		setSampleRate: () => Promise.resolve(),
		setFrequency: () => Promise.resolve(),
		setGain: () => Promise.resolve(),
		startRx: (cb) => {
			this._remoteClientCb = cb;
			return Promise.resolve();
		},
		stopRx: () => {
			this._remoteClientCb = null;
			return Promise.resolve();
		},
	};
}

export function setRemoteIqEnabled(this: Backend, enabled: boolean): void {
	if (this._remoteIqEnabled === enabled) return;
	this._remoteIqEnabled = enabled;
	this._remoteIqSequences.clear();
	for (let index = 0; index < (this.dspWorkers?.length ?? 0); index++) resetVfo(this, index);
}

export function setRemoteIqVfoParams(this: Backend, index: number, params: VfoParams, revision: number): void {
	this.setVfoParams(index, params);
	if (this._remoteIqRevisions[index] !== revision) {
		this._remoteIqRevisions[index] = revision;
		this._remoteIqSequences.delete(index);
		if (this._remoteIqEnabled) resetVfo(this, index);
	}
}

export function feedRemoteIqChunk(this: Backend, buffer: ArrayBuffer): void {
	if (!this._remoteIqEnabled || !this._remoteClientCb) return;
	const packet = unpackIqPacket(buffer);
	if (!packet || this._remoteIqRevisions[packet.index] !== packet.revision) return;
	const params = this.vfoParams?.[packet.index];
	const worker = this.dspWorkers?.[packet.index];
	if (!params || !worker || !this._iqDispatcher) return;
	const previous = this._remoteIqSequences.get(packet.index);
	if (isLateSequence(packet.sequence, previous)) return;
	if (!this._iqDispatcher.canSend(worker, true)) {
		if (this._perf) this._perf.droppedChunks++;
		return;
	}
	const discontinuity = packet.discontinuity || (previous !== undefined && packet.sequence !== (previous + 1) >>> 0);
	if (discontinuity && this.vfoStates?.[packet.index]) this.vfoStates[packet.index] = this._makeVfoState!();
	this._remoteIqSequences.set(packet.index, packet.sequence);
	const samples = new Float32Array(packet.samples.length);
	for (let i = 0; i < samples.length; i++) samples[i] = packet.samples[i] * packet.scale;
	// Sending transfers the buffer and detaches samples, so retain its size first.
	const sampleValues = samples.length;
	const sent = this._iqDispatcher.send(
		worker,
		{
			type: 'process',
			params,
			chunkId: packet.sequence,
			discontinuity,
			floatIq: true,
			preserveDc: !packet.fullBand,
			iqFormat: 'float32',
			sampleRate: packet.sampleRate,
			centerFreq: packet.centerFreq,
			sequence: packet.sequence,
			chunkLen: samples.length,
			chunk: samples.buffer,
		},
		[samples.buffer],
	);
	if (sent) recordIqInput(this, sampleValues);
}

function recordIqInput(backend: Backend, sampleValues: number): void {
	if (!backend._perf) return;
	backend._perf.usbCallbacks++;
	backend._perf.inputSamplesSum += sampleValues / 2;
	backend._perf.lastChunkSize = sampleValues;
}

function isLateSequence(sequence: number, previous: number | undefined): boolean {
	if (previous === undefined) return false;
	const delta = (sequence - previous) >>> 0;
	return delta === 0 || delta >= 0x80000000;
}

function resetVfo(backend: Backend, index: number): void {
	const params = backend.vfoParams?.[index];
	if (!params || !backend._spawnWorker || !backend._makeVfoState || !backend.dspWorkers) return;
	backend.dspWorkers[index]?.terminate();
	backend.vfoStates![index] = backend._makeVfoState();
	backend.dspWorkers[index] = backend._spawnWorker(index, params);
	backend._iqDispatcher?.retain(new Set(backend.dspWorkers));
}
