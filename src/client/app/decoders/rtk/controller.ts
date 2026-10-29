import type { AppInstance } from '@/app/core/receiver.types';
import type { RtkMessage } from '@/worker/decoders/rtk/types';

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
		if (message.profile !== undefined && message.profile !== (vfo.rtkProfile ?? 'rtk1')) return;
		if (this.rtk.frequencies[index] !== frequency) this.rtk.frames[index] = [];
		this.rtk.frequencies[index] = frequency;
		this.rtk.status[index] = message.status;
		this.rtk.sources[index] = message.stations;
		if (!this.rtk.frames[index]) this.rtk.frames[index] = [];
		const frames = this.rtk.frames[index];
		frames.push(...message.rtcm);
		if (frames.length > 512) frames.splice(0, frames.length - 512);
	},
};
