import type { AppInstance } from '@/app/core/receiver.types';
import type { ReceiverCommand } from '@/remote/types';
import type { VfoParams } from '@/worker/runtime/types';
import { planIqSlice, needsSlice } from '@/remote/iq/plan';
import * as Comlink from 'comlink';
import { isIqPacket, unpackIqPacket } from '@/remote/iq/packet';
import { REMOTE_IQ_BITS } from '@/remote/iq/types';

export function resetRemoteIqSession(app: AppInstance): void {
	app.remoteIqSupported = false;
	app.remoteIqActive = false;
	app.remoteIqKeys = [];
	app.remoteIqRevisions = [];
}

export function receiveRemoteIq(app: AppInstance, chunk: ArrayBuffer): boolean {
	if (!isIqPacket(chunk)) return app.remoteIqActive;
	Promise.resolve(app.backend.feedRemoteIqChunk(Comlink.transfer(chunk, [chunk]))).catch(console.error);
	return true;
}

export async function installHostIqCallback(app: AppInstance): Promise<void> {
	await app.backend.setRemoteHostIqCallback(
		Comlink.proxy((clientId: string, packet: ArrayBuffer) => {
			const parsed = unpackIqPacket(packet);
			if (parsed) app._webrtc?.sendIqChunkTo(clientId, packet, (parsed.sampleRate * parsed.bits) / 4, String(parsed.index));
		}),
	);
}

export const remoteIqMethods = {
	async applyRemoteDecoding(this: AppInstance): Promise<void> {
		if (this.remoteMode !== 'client' || !this.remoteIqSupported) return;
		const changed = this.remoteIqActive !== (this.remoteDecoding === 'client');
		this.remoteIqActive = this.remoteDecoding === 'client';
		await this.backend.setRemoteIqEnabled(this.remoteIqActive);
		this._resetAudioPlayback(changed);
		this._webrtc?.sendCommand({ type: 'clientStream', stream: this.remoteIqActive ? 'iq' : 'audio', bits: REMOTE_IQ_BITS });
		for (let index = 0; index < this.vfos.length; index++) this.updateBackendVfoParams(index);
	},
	sendRemoteVfo(this: AppInstance, index: number, params: VfoParams): void {
		// Volume, squelch and decoder preferences can update without invalidating RF.
		const key = JSON.stringify([params.freq, planIqSlice(params, this.radio.sampleRate, this.radio.centerFreq)]);
		if (this.remoteIqKeys[index] !== key) {
			this.remoteIqKeys[index] = key;
			this.remoteIqRevision = (this.remoteIqRevision + 1) >>> 0;
			this.remoteIqRevisions[index] = this.remoteIqRevision;
		}
		const revision = this.remoteIqRevisions[index];
		Promise.resolve(this.backend.setRemoteIqVfoParams(index, params, revision)).catch(console.error);
		this._webrtc?.sendCommand({ type: 'vfoUpdate', index, params, revision });
	},
};

export function handleIqCommand(app: AppInstance, command: ReceiverCommand, clientId: string | null): boolean {
	if (command.type === 'streamCapabilities') {
		if (app.remoteMode === 'client') {
			app.remoteIqSupported = true;
			Promise.resolve(app.applyRemoteDecoding()).catch(console.error);
		}
		return true;
	}
	if (command.type === 'clientStream') {
		if (app.remoteMode === 'host' && clientId) {
			Promise.resolve(app.backend.configureRemoteStream(clientId, command.stream, command.bits)).catch(console.error);
		}
		return true;
	}
	return false;
}

export function remoteIqSummary(app: AppInstance): string {
	if (!app.remoteIqActive) return 'Audio and decoded messages from the host.';
	let rate = 0;
	let fullBand = false;
	let missing = false;
	for (const vfo of app.vfos) {
		const plan = planIqSlice(vfo, app.radio.sampleRate, app.radio.centerFreq);
		if (plan) {
			rate += plan.sampleRate;
			fullBand ||= plan.fullBand;
		} else if (needsSlice(vfo)) missing = true;
	}
	return (
		`8-bit IQ payload: approximately ${((rate * REMOTE_IQ_BITS * 2) / 1e6).toFixed(2)} Mbps, plus waterfall and network overhead.` +
		(fullBand ? ' RTK scanning, Auto or hopping requires the full capture.' : '') +
		(missing ? ' Some VFOs need more bandwidth or are outside the capture.' : '')
	);
}
