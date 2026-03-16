import type { AppInstance } from './types';

export const rdsMethods = {
	toggleRdsPanel(this: AppInstance) {
		this.rds.panelOpen = !this.rds.panelOpen;
	},
	_onRdsMessage(this: AppInstance, vfoIndex: number, freqMhz: number, msg: any) {
		const time = new Date().toLocaleTimeString();
		const freq = freqMhz ? this.formatFreq(freqMhz) + ' MHz' : '';

		if (msg.pi !== undefined) {
			this.rds.pi = msg.pi;
			this.rds.freq = freq;
			this.rds.vfoIndex = vfoIndex;
		}
		if (msg.ps !== undefined) {
			this.rds.ps = msg.ps;
			this.rds.freq = freq;
			this.rds.vfoIndex = vfoIndex;
			this.rds.log.push({ time, field: 'PS', value: msg.ps, freq, vfoIndex });
		}
		if (msg.rt !== undefined) {
			this.rds.rt = msg.rt;
			this.rds.log.push({ time, field: 'RT', value: msg.rt, freq, vfoIndex });
		}
		if (msg.pty !== undefined) {
			this.rds.pty = msg.pty;
			this.rds.ptyLabel = msg.ptyLabel || '';
		}
		if (msg.tp !== undefined) this.rds.tp = msg.tp;
		if (msg.ta !== undefined) this.rds.ta = msg.ta;

		// Auto-scroll log
		this.$nextTick(() => {
			const el = this.$refs.rdsBody;
			if (el) el.scrollTop = el.scrollHeight;
		});
	},
	clearRds(this: AppInstance) {
		this.rds.log = [];
		this.rds.ps = '';
		this.rds.rt = '';
		this.rds.pi = '';
		this.rds.pty = 0;
		this.rds.ptyLabel = '';
		this.rds.tp = false;
		this.rds.ta = false;
	},
	exportRds(this: AppInstance) {
		const lines = this.rds.log.map((e: any) =>
			`[${e.time}] ${e.freq}  ${e.field}: ${e.value}`
		);
		const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `rds-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
		a.click();
		URL.revokeObjectURL(url);
	},
};
