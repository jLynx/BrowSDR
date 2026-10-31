import type { Backend } from '@/worker/runtime/backend';
import type { IqRecording, IqReplayProgress } from '@/radio/iq-replay/types';
import { IqReplayDevice } from '@/devices/iq-replay';

export function openIqReplay(this: Backend, recording: IqRecording): void {
	if (!import.meta.env.DEV) throw new Error('IQ file replay is only available in development.');
	if (this.device) throw new Error('A receiver is already connected.');
	this.device = new IqReplayDevice(recording);
}

export async function replaceIqReplay(this: Backend, recording: IqRecording): Promise<void> {
	if (!import.meta.env.DEV) throw new Error('IQ file replay is only available in development.');
	if (!(this.device instanceof IqReplayDevice)) throw new Error('Connect an IQ recording first.');
	const replacement = new IqReplayDevice(recording);
	const previous = this.device;
	await this.stopRx();
	await previous.close();
	this.device = replacement;
}

export function getIqReplayProgress(this: Backend): IqReplayProgress | null {
	if (!(this.device instanceof IqReplayDevice)) return null;
	const progress = this.device.progress;
	if (progress.state === 'ended' && (this._iqDispatcher?.busy || this._replayPending?.())) progress.state = 'draining';
	return progress;
}

export function rewindIqReplay(this: Backend): void {
	if (!(this.device instanceof IqReplayDevice)) throw new Error('Connect an IQ recording first.');
	this.device.rewind();
}
