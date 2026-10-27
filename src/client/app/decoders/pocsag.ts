import type { POCSAGMessage, POCSAGStatus } from '@/worker/decoders/types';
import type { AppInstance } from '@/app/core/receiver.types';
import { defaultCharset } from '@/worker/decoders/charsets';
import { applyPagerRxDefaults, pagerAutoScroll } from '@/app/decoders/pager';

/** POCSAG-specific app mixin methods. POCSAG is one pager protocol among peers
 * (GSC, FLEX); the shared log/render/export lives in pager.ts. */
export const pocsagMethods = {
	/**
	 * Decode-POCSAG toggle. On enable, apply the shared NFM-paging RX defaults
	 * (low-pass off, bandwidth >= 12500) so it works well out of the box.
	 */
	togglePocsag(this: AppInstance, i: number) {
		applyPagerRxDefaults(this, i, this.vfos[i].pocsag);
	},
	/** Current POCSAG charset value string for a VFO's <select> binding. */
	pocsagCharsetValue(this: AppInstance, i: number): string {
		const k = this.vfos[i]?.pocsagCharset ?? defaultCharset('pocsag');
		return `${k.vendor}\u0000${k.model}\u0000${k.codepage}`;
	},
	/** Apply a POCSAG charset selection to a VFO and push it to the decoder. */
	setPocsagCharset(this: AppInstance, i: number, value: string) {
		const [vendor, model, codepage] = value.split('\u0000');
		this.vfos[i].pocsagCharset = { vendor, model, codepage };
		this.updateBackendVfoParams(i);
	},
	/** Apply the POCSAG type-detection mode (auto/alpha/numeric) to a VFO. */
	setPocsagMode(this: AppInstance, i: number, value: string) {
		this.vfos[i].pocsagMode = value === 'alpha' || value === 'numeric' ? value : 'auto';
		this.updateBackendVfoParams(i);
	},
	_onPocsagStatus(this: AppInstance, vfoIndex: number, _freqMhz: number, status: POCSAGStatus) {
		if (!this.pocsagStatus) this.pocsagStatus = [];
		// Carry last-known BER forward so the UI can dim it during hunt.
		const prev = this.pocsagStatus[vfoIndex];
		const lastBer = status.ber != null ? status.ber : ((prev as (POCSAGStatus & { lastBer?: number }) | null)?.lastBer ?? null);
		this.pocsagStatus[vfoIndex] = Object.assign(status, { lastBer });
	},
	_onPocsagMessage(this: AppInstance, vfoIndex: number, freqMhz: number, msg: POCSAGMessage) {
		const time = new Date().toLocaleTimeString();
		const freq = freqMhz ? this.formatFreq(freqMhz) + ' MHz' : '';
		this.pager.log.push({
			protocol: 'pocsag',
			time,
			freq,
			vfoIndex,
			// POCSAG RIC addresses are shown zero-padded to 7 digits (the RIC
			// maximum, 2097151 = 2^21-1, is 7 digits) for aligned columns.
			capcode: String(msg.capcode).padStart(7, '0'),
			type: msg.type,
			func: msg.func,
			text: msg.text,
			charStatus: msg.charStatus ?? [],
			baud: msg.baud,
			inverted: msg.inverted,
			detectDebug: msg.detectDebug,
			alt: msg.alt,
		});
		pagerAutoScroll(this);
	},
};
