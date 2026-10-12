import type { AppInstance } from '@/app/core/receiver.types';
import type { AcarsMessage } from '@/worker/decoders/acars/types';
import { isAcarsFrequency } from '@/worker/decoders/acars';

export const acarsMethods = {
	tuneAcarsVfo(this: AppInstance, frequency: number, index = this.activeVfoIndex): void {
		if (this.vfos[index] && isAcarsFrequency(frequency)) this.validateAndApplyVfoFreq(index, frequency);
	},
	toggleAcarsPanel(this: AppInstance): void {
		this.acars.panelOpen = !this.acars.panelOpen;
	},
	_onAcarsMessage(this: AppInstance, index: number, freq: number, message: AcarsMessage): void {
		const vfo = this.vfos[index];
		if (!this.running || !vfo?.acars || vfo.freq !== freq || message.freq !== freq) return;
		this.acars.status[index] = message.status;
		this.acars.sources[index] = { freq, messages: message.messages };
	},
	acarsStatusText(this: AppInstance, index: number): string {
		if (!this.running) return 'Start reception to decode';
		const status = this.acars.sources[index]?.freq === this.vfos[index]?.freq ? this.acars.status[index] : null;
		return status ? `${status.message} · ${status.frames} valid frames` : 'Starting decoder…';
	},
};
