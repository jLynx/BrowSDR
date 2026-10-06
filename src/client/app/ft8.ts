import { markRaw } from 'vue';
import type { AppInstance } from './types';

export const FT8_BANDS = [
	{ name: '160 m', mhz: 1.840 }, { name: '80 m', mhz: 3.573 },
	{ name: '40 m', mhz: 7.074 }, { name: '30 m', mhz: 10.136 },
	{ name: '20 m', mhz: 14.074 }, { name: '17 m', mhz: 18.100 },
	{ name: '15 m', mhz: 21.074 }, { name: '12 m', mhz: 24.915 },
	{ name: '10 m', mhz: 28.074 }, { name: '6 m', mhz: 50.313 },
	{ name: '2 m', mhz: 144.174 },
];

export const ft8Methods = {
	toggleFt8Panel(this: AppInstance) { this.ft8.panelOpen = !this.ft8.panelOpen; },
	startFt8(this: AppInstance) {
		if (!this.running || this.remoteMode === 'client') return;
		const vfo = this.vfos[this.ft8.vfoIndex];
		if (!vfo || vfo.mode !== 'usb' || !this.isFreqInBandwidth(vfo.freq)) {
			this.showMsg('Select a USB VFO within the receiver bandwidth.');
			return;
		}
		this.stopFt8();
		vfo.bandwidth = 3000;
		vfo.squelchEnabled = false;
		vfo.noiseReduction = false;
		vfo.lowPass = false;
		vfo.highPass = false;
		this.ft8.active = true;
		this.ft8.status = 'Loading decoder…';
		this.ft8.progress = 0;
		this._ft8Freq = vfo.freq;
		this._ft8Worker = markRaw(new Worker(new URL('../ft8-worker.ts', import.meta.url), { type: 'module' }));
		this._ft8Worker.onmessage = (event: MessageEvent) => {
			const msg = event.data;
			if (msg.type === 'ready') { this._ft8Ready = true; this.ft8.status = 'Waiting for next UTC slot…'; }
			if (msg.type === 'progress') {
				this.ft8.progress = msg.progress;
				this.ft8.status = msg.collecting ? 'Receiving' : 'Waiting for next UTC slot…';
			}
			if (msg.type === 'decoding') this.ft8.status = 'Decoding…';
			if (msg.type === 'result') {
				this.ft8.slots++;
				this.ft8.lastDecode = `${msg.messages.length} messages · ${Math.round(msg.duration)} ms`;
				for (const message of msg.messages) this.ft8.log.push({ ...message, slot: msg.slot, freq: this._ft8Freq, vfoIndex: this.ft8.vfoIndex });
				if (this.ft8.log.length > 1000) this.ft8.log.splice(0, this.ft8.log.length - 1000);
				this.$nextTick(() => { const body = this.$refs.ft8Body; if (body) body.scrollTop = body.scrollHeight; });
			}
			if (msg.type === 'error') { this.stopFt8(); this.ft8.status = `Decoder error: ${msg.error}`; }
		};
		this._ft8Worker.onerror = (event: ErrorEvent) => { this.stopFt8(); this.ft8.status = `Decoder error: ${event.message}`; };
		this._ft8Worker.postMessage({ type: 'init' });
		this.updateAllBackendVfoParams();
	},
	stopFt8(this: AppInstance) {
		this._ft8Worker?.terminate();
		this._ft8Worker = null;
		this._ft8Ready = false;
		this.ft8.active = false;
		this.ft8.status = 'Stopped';
		this.ft8.progress = 0;
		this.updateAllBackendVfoParams();
	},
	_feedFt8(this: AppInstance, index: number, freq: number, samples: Float32Array, endTime: number) {
		if (!this.ft8.active || !this._ft8Ready || index !== this.ft8.vfoIndex || freq !== this._ft8Freq) return;
		this._ft8Worker.postMessage({ type: 'audio', samples: samples.buffer, endTime }, [samples.buffer]);
	},
	_ft8ConfigChanged(this: AppInstance) {
		if (!this.ft8.active) return;
		const vfo = this.vfos[this.ft8.vfoIndex];
		if (!this.running || !vfo || vfo.mode !== 'usb' || this.remoteMode === 'client' || !this.isFreqInBandwidth(vfo.freq)) this.stopFt8();
		else this.startFt8();
	},
	tuneFt8Band(this: AppInstance) {
		if (this.remoteMode === 'client') return;
		const freq = Number(this.ft8.band);
		const vfo = this.vfos[this.ft8.vfoIndex];
		if (!vfo) return;
		this.stopFt8();
		vfo.freq = freq;
		vfo.displayFreq = this.formatFreq(freq);
		vfo.mode = 'usb';
		this.applyModeDefaults(this.ft8.vfoIndex);
		vfo.bandwidth = 3000;
		// Keep FT8 away from the receiver's central DC spur.
		this.radio.centerFreq = freq + 0.025;
		this.updateAllBackendVfoParams();
	},
	ft8Utc(this: AppInstance, slot: number) { return new Date(slot).toISOString().slice(11, 19); },
	clearFt8(this: AppInstance) { this.ft8.log = []; this.ft8.slots = 0; this.ft8.lastDecode = ''; },
	exportFt8(this: AppInstance) {
		const lines = ['UTC,Dial MHz,VFO,Sync,DT seconds,Audio Hz,Message', ...this.ft8.log.map((entry: any) =>
			`${new Date(entry.slot).toISOString()},${entry.freq.toFixed(6)},${entry.vfoIndex + 1},${entry.sync},${entry.dt.toFixed(2)},${entry.hz.toFixed(1)},"${entry.text.replaceAll('"', '""')}"`)];
		const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
		const link = document.createElement('a'); link.href = url; link.download = `ft8-rx-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
	},
};
