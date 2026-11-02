import type { Backend } from '@/worker/runtime/backend';
import type { DspOutput } from '@/worker/runtime/dsp-messages.types';
import type { HdRadioCallback, HostCallback } from '@/worker/runtime/callbacks.types';
import type { RemoteClientState } from '@/worker/runtime/types';

export function setRemoteHostHdRadioCallback(this: Backend, callback: HostCallback<Parameters<HdRadioCallback>>): void {
	this._remoteHostHdRadioCb = callback;
}

export function routeHdRadioMessage(backend: Backend, worker: Worker, message: DspOutput, callback: HdRadioCallback | null): boolean {
	if (message.type !== 'hd_radio') return false;
	const index = backend.dspWorkers!.indexOf(worker);
	const params = backend.vfoParams?.[index];
	if (params?.mode === 'hdradio' && params.freq === message.freq) callback?.(index, params.freq, message);
	return true;
}

export function forwardHdRadioMessage(
	backend: Backend,
	clientId: string,
	state: RemoteClientState,
	index: number,
	message: DspOutput,
): boolean {
	if (message.type !== 'hd_radio') return false;
	const params = state.params[index];
	if (params?.mode === 'hdradio' && params.freq === message.freq) backend._remoteHostHdRadioCb?.(clientId, index, params.freq, message);
	return true;
}
