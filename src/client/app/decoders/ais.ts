import type { AppInstance } from '@/app/core/receiver.types';
import type { AisMessage } from '@/worker/decoders/ais/types';

export const aisMethods = {
	tuneAisVfo(this: AppInstance, frequency: number, index = this.activeVfoIndex): void {
		if (this.vfos[index] && [161.975, 162.025].includes(frequency)) this.validateAndApplyVfoFreq(index, frequency);
	},
	toggleAisPanel(this: AppInstance): void {
		this.ais.panelOpen = !this.ais.panelOpen;
	},
	_onAisMessage(this: AppInstance, index: number, freq: number, message: AisMessage): void {
		const vfo = this.vfos[index];
		if (!this.running || !vfo?.ais || vfo.freq !== freq) return;
		this.ais.status[index] = message.status;
		this.ais.sources[index] = message.vessels;
	},
	aisStatusText(this: AppInstance, index: number): string {
		if (!this.running) return 'Start reception to decode';
		const status = this.ais.status[index];
		return status ? `${status.message} · ${status.frames} valid frames` : 'Starting decoder…';
	},
};
