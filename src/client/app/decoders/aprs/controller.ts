import type { AppInstance } from '@/app/core/receiver.types';
import type { AprsMessage } from '@/worker/decoders/aprs/types';
import { isAprsFrequency } from '@/worker/decoders/aprs';

export const aprsMethods = {
	tuneAprsVfo(this: AppInstance, frequency: number, index = this.activeVfoIndex): void {
		if (this.vfos[index] && isAprsFrequency(frequency)) this.validateAndApplyVfoFreq(index, frequency);
	},
	toggleAprsPanel(this: AppInstance): void {
		this.aprs.panelOpen = !this.aprs.panelOpen;
	},
	_onAprsMessage(this: AppInstance, index: number, freq: number, message: AprsMessage): void {
		const vfo = this.vfos[index];
		if (!this.running || !vfo?.aprs || vfo.freq !== freq || message.freq !== freq) return;
		this.aprs.status[index] = message.status;
		this.aprs.sources[index] = { freq, stations: message.stations, packets: message.packets };
	},
	aprsStatusText(this: AppInstance, index: number): string {
		if (!this.running) return 'Start reception to decode';
		const status = this.aprs.sources[index]?.freq === this.vfos[index]?.freq ? this.aprs.status[index] : null;
		return status ? `${status.message} · ${status.frames} valid frames` : 'Starting decoder…';
	},
};
