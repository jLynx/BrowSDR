import { markRaw } from 'vue';
import type { AppInstance } from './types';
import { ft8SourceIndices, ft8SourceUnavailable } from '../ft8/sources';

export const FT8_BANDS = [
	{ name: '160 m', mhz: 1.840 }, { name: '80 m', mhz: 3.573 },
	{ name: '40 m', mhz: 7.074 }, { name: '30 m', mhz: 10.136 },
	{ name: '20 m', mhz: 14.074 }, { name: '17 m', mhz: 18.100 },
	{ name: '15 m', mhz: 21.074 }, { name: '12 m', mhz: 24.915 },
	{ name: '10 m', mhz: 28.074 }, { name: '6 m', mhz: 50.313 },
	{ name: '2 m', mhz: 144.174 },
];

interface Receiver {
	worker: Worker;
	ready: boolean;
	key: string;
	freq: number;
	vfo: object;
}
export interface FT8Channel {
	status: string;
	progress: number;
	slots: number;
	messages: number;
	lastDecode: string;
}
const newChannel = (): FT8Channel => ({ status: 'Loading decoder…', progress: 0, slots: 0, messages: 0, lastDecode: '' });

export const ft8Methods = {
	toggleFt8Panel(this: AppInstance) { this.ft8.panelOpen = !this.ft8.panelOpen; },
	ft8EligibleSources(this: AppInstance): number[] {
		return ft8SourceIndices(this.ft8.source, this.vfos, this.radio.centerFreq, this.radio.sampleRate);
	},
	ft8SourceStatus(this: AppInstance, index: number): string {
		return ft8SourceUnavailable(this.vfos[index], this.radio.centerFreq, this.radio.sampleRate) ||
			(this.ft8.active ? this.ft8.channels[index]?.status || 'Not selected' : 'Stopped');
	},
	ft8Monitoring(this: AppInstance, index: number): boolean {
		return this.ft8.active && !!this._ft8Receivers?.has(index);
	},
	ft8VisibleLog(this: AppInstance) {
		return this.ft8.logFilter === 'all' ? this.ft8.log : this.ft8.log.filter((entry: any) => String(entry.vfoIndex) === this.ft8.logFilter);
	},
	startFt8(this: AppInstance) {
		if (!this.running || this.remoteMode === 'client') return;
		if (!this.ft8EligibleSources().length) {
			this.showMsg('Select USB VFOs within the receiver bandwidth.');
			return;
		}
		this.ft8.active = true;
		this._syncFt8Receivers();
	},
	_syncFt8Receivers(this: AppInstance) {
		if (!this.ft8.active) return;
		if (!this.running || this.remoteMode === 'client') { this.stopFt8(); return; }
		if (!this._ft8Receivers) this._ft8Receivers = markRaw(new Map<number, Receiver>());
		const receivers = this._ft8Receivers as Map<number, Receiver>;
		const desired = this.ft8EligibleSources();
		for (const [index, receiver] of receivers) {
			if (!desired.includes(index)) {
				receiver.worker.terminate(); receivers.delete(index); delete this.ft8.channels[index];
			}
		}
		for (const index of desired) {
			const vfo = this.vfos[index];
			vfo.bandwidth = 3000;
			vfo.squelchEnabled = false;
			vfo.noiseReduction = false;
			vfo.lowPass = false;
			vfo.highPass = false;
			const key = JSON.stringify([vfo.freq, vfo.mode, this.radio.centerFreq, this.radio.sampleRate,
				this.radio.frequencyShift, this.gains['RX Channel'], this.gains.Antenna]);
			const previous = receivers.get(index);
			if (previous?.key === key && previous.vfo === vfo) continue;
			previous?.worker.terminate();
			const worker = markRaw(new Worker(new URL('../ft8-worker.ts', import.meta.url), { type: 'module' }));
			const receiver: Receiver = { worker, ready: false, key, freq: vfo.freq, vfo };
			receivers.set(index, receiver);
			this.ft8.channels[index] = newChannel();
			// Ignore queued events from receivers replaced during retuning or removal.
			const current = () => this.ft8.active && receivers.get(index) === receiver;
			const fail = (error: string) => {
				if (!current()) return;
				receiver.ready = false;
				worker.terminate();
				this.ft8.channels[index].status = `Decoder error: ${error}`;
			};
			worker.onmessage = (event: MessageEvent) => {
				if (!current()) return;
				const msg = event.data;
				const channel = this.ft8.channels[index] as FT8Channel;
				if (msg.type === 'ready') { receiver.ready = true; channel.status = 'Waiting for next UTC slot…'; }
				if (msg.type === 'progress') {
					channel.progress = msg.progress;
					channel.status = msg.collecting ? 'Receiving' : 'Waiting for next UTC slot…';
				}
				if (msg.type === 'decoding') channel.status = 'Decoding…';
				if (msg.type === 'result') {
					channel.slots++;
					channel.messages += msg.messages.length;
					channel.lastDecode = `${msg.messages.length} messages · ${Math.round(msg.duration)} ms`;
					for (const message of msg.messages) this.ft8.log.push({ ...message, slot: msg.slot, freq: receiver.freq, vfoIndex: index });
					if (this.ft8.log.length > 10000) this.ft8.log.splice(0, this.ft8.log.length - 10000);
					this.$nextTick(() => { const body = this.$refs.ft8Body; if (body) body.scrollTop = body.scrollHeight; });
				}
				if (msg.type === 'error') fail(msg.error);
			};
			worker.onerror = (event: ErrorEvent) => fail(event.message);
			worker.postMessage({ type: 'init' });
		}
		this.updateAllBackendVfoParams();
	},
	stopFt8(this: AppInstance) {
		for (const receiver of this._ft8Receivers?.values() || []) receiver.worker.terminate();
		this._ft8Receivers?.clear();
		this.ft8.active = false;
		for (const channel of Object.values(this.ft8.channels) as FT8Channel[]) { channel.status = 'Stopped'; channel.progress = 0; }
		this.updateAllBackendVfoParams();
	},
	_feedFt8(this: AppInstance, index: number, freq: number, samples: Float32Array, endTime: number) {
		const receiver = this._ft8Receivers?.get(index) as Receiver | undefined;
		if (!this.ft8.active || !receiver?.ready || freq !== receiver.freq) return;
		receiver.worker.postMessage({ type: 'audio', samples: samples.buffer, endTime }, [samples.buffer]);
	},
	_ft8ConfigChanged(this: AppInstance) { this._syncFt8Receivers(); },
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
		this.radio.centerFreq = freq + 0.025;
		this.updateAllBackendVfoParams();
	},
	ft8Utc(this: AppInstance, slot: number) { return new Date(slot).toISOString().slice(11, 19); },
	clearFt8(this: AppInstance) {
		this.ft8.log = [];
		for (const channel of Object.values(this.ft8.channels) as FT8Channel[]) { channel.slots = 0; channel.messages = 0; channel.lastDecode = ''; }
	},
	exportFt8(this: AppInstance) {
		const lines = ['UTC,Dial MHz,VFO,Sync,DT seconds,Audio Hz,Message', ...this.ft8.log.map((entry: any) =>
			`${new Date(entry.slot).toISOString()},${entry.freq.toFixed(6)},${entry.vfoIndex + 1},${entry.sync},${entry.dt.toFixed(2)},${entry.hz.toFixed(1)},"${entry.text.replaceAll('"', '""')}"`)];
		const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
		const link = document.createElement('a'); link.href = url; link.download = `ft8-rx-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
	},
};
