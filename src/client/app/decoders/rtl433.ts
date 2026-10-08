import type { AppInstance } from '../core/types';
import type { Rtl433Status, Rtl433Message } from '../../worker/decoders/rtl433';

export const rtl433Methods = {
	toggleRtl433Panel(this: AppInstance) {
		this.rtl433.panelOpen = !this.rtl433.panelOpen;
	},
	_onRtl433Message(this: AppInstance, index: number, freq: number, msg: Rtl433Message) {
		const vfo = this.vfos[index];
		if (!vfo || !this.running) return;
		if (msg.type === 'rtl433_status') {
			if (vfo.freq !== freq) return;
			const status: Rtl433Status = msg.status;
			if (status.protocols) this.rtl433.protocols = status.protocols;
			this.rtl433.status[index] = { ...status, protocols: undefined };
		} else if (msg.type === 'rtl433_event' && vfo.rtl433 && vfo.freq === freq) {
			this.rtl433.log.push({ time: new Date().toISOString(), freq: this.formatFreq(freq), vfoIndex: index, event: msg.event });
			if (this.rtl433.log.length > 1000) this.rtl433.log.splice(0, this.rtl433.log.length - 1000);
			Promise.resolve(
				this.$nextTick(() => {
					const el = this.$refs.rtl433Body;
					if (el) el.scrollTop = el.scrollHeight;
				}),
			).catch((error: unknown) => console.error(error));
		}
	},
	rtl433StatusText(this: AppInstance, index: number): string {
		if (!this.vfos[index]?.rtl433) return 'Decoder off';
		if (!this.running) return 'Start reception to decode';
		const status = this.rtl433.status[index];
		return status
			? `${status.message}${status.state === 'receiving' ? ` · ${(status.samples / 1e6).toFixed(1)}M samples · ${status.events} events` : ''}`
			: 'Starting decoder…';
	},
	formatRtl433Event(this: AppInstance, event: Record<string, unknown>): string {
		return Object.entries(event)
			.filter(([key]) => !['model', 'id', 'protocol'].includes(key))
			.map(([key, value]) => `${key}: ${typeof value === 'string' ? value : (JSON.stringify(value) ?? '')}`)
			.join(' · ');
	},
	filteredRtl433Protocols(this: AppInstance) {
		const filter = this.rtl433.filter.trim().toLowerCase();
		return this.rtl433.protocols.filter((protocol) => `${protocol.id} ${protocol.name}`.toLowerCase().includes(filter));
	},
	clearRtl433(this: AppInstance) {
		this.rtl433.log = [];
	},
	exportRtl433(this: AppInstance) {
		const blob = new Blob([this.rtl433.log.map((entry) => JSON.stringify(entry)).join('\n')], { type: 'application/x-ndjson' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `rtl433-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.jsonl`;
		a.click();
		URL.revokeObjectURL(url);
	},
};
