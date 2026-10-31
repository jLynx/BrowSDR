import type { AppInstance } from '@/app/core/receiver.types';
import type { Vfo } from '@/app/core/types';
import type { RtkMessage } from '@/worker/decoders/rtk/types';
import { discoverFollowers } from './discovery/followers';

function matchingProfile(vfo: Vfo, message: RtkMessage): boolean {
	if (vfo.rtkProfile === 'scan') return message.profile === undefined && (!!message.status.scan || message.status.state !== 'receiving');
	if (message.status.scan) return false;
	if (message.profile === undefined) return true;
	return vfo.rtkProfile === 'auto' ? message.status.detectedProfile === message.profile : message.profile === (vfo.rtkProfile ?? 'rtk1');
}

export const rtkMethods = {
	tuneRtkVfo(this: AppInstance, frequency: number): void {
		const index = this.activeVfoIndex;
		if (!this.vfos[index]) return;
		this.validateAndApplyVfoFreq(index, frequency);
		this.updateBackendVfoParams(index);
	},
	_onRtkMessage(this: AppInstance, index: number, frequency: number, message: RtkMessage): void {
		const vfo = this.vfos[index];
		if (!this.running || !vfo?.rtk || vfo.freq !== frequency || message.freq !== frequency) return;
		if (!matchingProfile(vfo, message)) return;
		if (this.rtk.frequencies[index] !== frequency) this.rtk.frames[index] = [];
		this.rtk.frequencies[index] = frequency;
		this.rtk.status[index] = message.status;
		this.rtk.sources[index] = message.stations;
		if (!this.rtk.frames[index]) this.rtk.frames[index] = [];
		const frames = this.rtk.frames[index];
		frames.push(...message.rtcm);
		if (frames.length > 512) frames.splice(0, frames.length - 512);
		if (message.status.scan) discoverFollowers(this, vfo, message.stations);
	},
};
