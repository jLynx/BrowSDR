import type { AppInstance } from '@/app/core/receiver.types';
import type { AdsbMessage } from '@/worker/decoders/adsb/types';

export const adsbMethods = {
	tuneAdsbVfo(this: AppInstance, index = this.activeVfoIndex): void {
		if (!this.vfos[index]) return;
		this.validateAndApplyVfoFreq(index, 1090);
	},
	toggleAdsbPanel(this: AppInstance): void {
		this.adsb.panelOpen = !this.adsb.panelOpen;
	},
	_onAdsbMessage(this: AppInstance, index: number, freq: number, message: AdsbMessage): void {
		const vfo = this.vfos[index];
		if (!this.running || !vfo?.adsb || vfo.freq !== freq) return;
		this.adsb.status[index] = message.status;
		this.adsb.sources[index] = message.aircraft;
	},
	adsbStatusText(this: AppInstance, index: number): string {
		if (!this.running) return 'Start reception to decode';
		const status = this.adsb.status[index];
		return status ? `${status.message} · ${status.frames} valid frames` : 'Starting decoder…';
	},
};
