import type { AppInstance } from '@/app/core/receiver.types';
import type { RadiosondeMessage } from '@/worker/decoders/radiosonde/types';

export const radiosondeMethods = {
	tuneRadiosondeVfo(this: AppInstance, index = this.activeVfoIndex): void {
		if (this.vfos[index]) this.validateAndApplyVfoFreq(index, 403);
	},
	toggleRadiosondePanel(this: AppInstance): void {
		this.radiosonde.panelOpen = !this.radiosonde.panelOpen;
	},
	_onRadiosondeMessage(this: AppInstance, index: number, freq: number, message: RadiosondeMessage): void {
		const vfo = this.vfos[index];
		if (!this.running || !vfo?.radiosonde || vfo.freq !== freq) return;
		this.radiosonde.status[index] = message.status;
		this.radiosonde.sources[index] = message.sondes;
	},
	radiosondeStatusText(this: AppInstance, index: number): string {
		if (!this.running) return 'Start reception to decode';
		const status = this.radiosonde.status[index];
		return status ? `${status.message} · ${status.frames} valid frames · ${status.syncs} syncs` : 'Starting decoder…';
	},
};
