import type { Backend } from '@/worker/runtime/backend';
import type { RemoteClientState } from '@/worker/runtime/types';
import type { DspOutput } from '@/worker/runtime/dsp-messages.types';
import { stampIqSequence } from './packet';

export function forwardIqMessage(backend: Backend, clientId: string, state: RemoteClientState, index: number, msg: DspOutput): boolean {
	if (msg.type !== 'iq_slice') return false;
	if (state.stream === 'iq' && msg.index === index && state.revisions?.[index] === msg.revision) {
		const sequences = (state.iqSequences ??= []);
		for (const packet of msg.packets) {
			stampIqSequence(packet, sequences[index] ?? 0);
			sequences[index] = ((sequences[index] ?? 0) + 1) >>> 0;
			backend._remoteHostIqCb?.(clientId, packet);
		}
	}
	return true;
}

export function configureRemoteStream(this: Backend, clientId: string, stream: 'audio' | 'iq', _bits: 8 | 16): void {
	// Accept older clients' precision requests; extraction always uses REMOTE_IQ_BITS.
	const state = this._remoteClients?.get(clientId);
	if (!state || state.stream === stream) return;
	state.stream = stream;
	for (let index = 0; index < state.workers.length; index++) {
		state.workers[index]?.terminate();
		state.workers[index] = null;
		state.audioQueues[index].len = 0;
		state.pocsagDecoders[index] = null;
		if (state.gscDecoders) state.gscDecoders[index] = null;
		if (state.flexDecoders) state.flexDecoders[index] = null;
		state.rdsDecoders[index] = null;
		const params = state.params[index];
		if (params) void this.setRemoteVfoParams(clientId, index, params, state.revisions?.[index]);
	}
}

export function setRemoteHostIqCallback(this: Backend, callback: (clientId: string, packet: ArrayBuffer) => void): void {
	this._remoteHostIqCb = callback;
}
