import type { POCSAGMessage } from '@/worker/runtime/types';
import type { AppInstance } from '@/app/core/types';

export const pocsagMethods = {
	togglePocsagPanel(this: AppInstance) {
		this.pocsag.panelOpen = !this.pocsag.panelOpen;
	},
	_onPocsagMessage(this: AppInstance, vfoIndex: number, freqMhz: number, msg: POCSAGMessage) {
		const time = new Date().toLocaleTimeString();
		const freq = freqMhz ? this.formatFreq(freqMhz) + ' MHz' : '';
		this.pocsag.log.push({
			time,
			freq,
			vfoIndex,
			capcode: String(msg.capcode),
			type: msg.type,
			text: msg.text,
			baud: msg.baud,
		});
		// Auto-scroll
		Promise.resolve(
			this.$nextTick(() => {
				const el = this.$refs.pocsagBody;
				if (el) el.scrollTop = el.scrollHeight;
			}),
		).catch((error: unknown) => console.error(error));
	},
	clearPocsag(this: AppInstance) {
		this.pocsag.log = [];
	},
	exportPocsag(this: AppInstance) {
		const lines = this.pocsag.log.map((e) => `[${e.time}] ${e.freq}  CAP:${e.capcode}  TYPE:${e.type}  ${e.text || '(tone)'}`);
		const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `pocsag-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
		a.click();
		URL.revokeObjectURL(url);
	},
};
