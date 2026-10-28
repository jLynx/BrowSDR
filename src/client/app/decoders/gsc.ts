import type { GSCMessage, GSCStatus } from '@/worker/decoders/types';
import type { AppInstance } from '@/app/core/receiver.types';
import { applyPagerRxDefaults, pagerAutoScroll } from '@/app/decoders/pager';

/** Format a GSC 7-symbol functional address for display. The raw address is
 * I G1 G0 A2 A1 A0 <suffix>: group it as I-G1G0-A2A1A0 with the function suffix
 * appended after a space, e.g. "1234567" -> "1-23-456 7". Anything that does
 * not match the expected shape is returned unchanged. */
export function formatGscAddress(addr: string): string {
	if (addr.length < 6) return addr;
	const i = addr[0];
	const g = addr.slice(1, 3);
	const a = addr.slice(3, 6);
	const suffix = addr.slice(6);
	return suffix ? `${i}-${g}-${a} ${suffix}` : `${i}-${g}-${a}`;
}

/** GSC-specific app mixin methods. GSC is one pager protocol among peers
 * (POCSAG, FLEX); the shared log/render/export lives in pager.ts. */
export const gscMethods = {
	/** Decode-GSC toggle. Applies the shared NFM-paging RX defaults on enable. */
	toggleGsc(this: AppInstance, i: number) {
		applyPagerRxDefaults(this, i, this.vfos[i].gsc);
	},
	_onGscStatus(this: AppInstance, vfoIndex: number, _freqMhz: number, status: GSCStatus) {
		if (!this.gscStatus) this.gscStatus = [];
		// Carry last-known BER forward so the UI can dim it during hunt.
		const prev = this.gscStatus[vfoIndex];
		const lastBer = status.ber != null ? status.ber : (prev?.lastBer ?? null);
		this.gscStatus[vfoIndex] = Object.assign(status, { lastBer });
	},
	_onGscMessage(this: AppInstance, vfoIndex: number, freqMhz: number, msg: GSCMessage) {
		const time = new Date().toLocaleTimeString();
		const freq = freqMhz ? this.formatFreq(freqMhz) + ' MHz' : '';
		this.pager.log.push({
			protocol: 'gsc',
			time,
			freq,
			vfoIndex,
			capcode: formatGscAddress(msg.address),
			type: msg.type,
			text: msg.text,
			charStatus: msg.charStatus ?? [],
			errorCount: msg.errorCount,
			uncorrectableCount: msg.uncorrectableCount,
			voiceEvent: msg.voiceEvent,
			voiceEndReason: msg.voiceEndReason,
			inverted: msg.inverted,
			alt: msg.alt,
		});
		if (msg.voiceEvent) this._gscAutoListen(vfoIndex, msg.voiceEvent);
		pagerAutoScroll(this);
	},
	/** On a GSC voice page, if the VFO has auto-listen enabled, unmute and open
	 * squelch for the announcement, restoring the prior state when it ends. */
	_gscAutoListen(this: AppInstance, vfoIndex: number, event: 'start' | 'stop') {
		const vfo = this.vfos[vfoIndex];
		if (!vfo || !vfo.gscAutoListen) return;
		if (event === 'start') {
			this._gscPriorMute.set(vfoIndex, { enabled: vfo.enabled, squelchEnabled: vfo.squelchEnabled });
			if (!vfo.enabled) {
				vfo.enabled = true;
				this.toggleVfoCheckbox(vfoIndex);
			}
			vfo.squelchEnabled = false;
		} else {
			const prior = this._gscPriorMute.get(vfoIndex);
			if (prior) {
				vfo.squelchEnabled = prior.squelchEnabled;
				if (vfo.enabled !== prior.enabled) {
					vfo.enabled = prior.enabled;
					this.toggleVfoCheckbox(vfoIndex);
				}
				this._gscPriorMute.delete(vfoIndex);
			}
		}
	},
};
