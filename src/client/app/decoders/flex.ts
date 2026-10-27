import type { FlexMessage, FlexStatus } from '@/worker/decoders/types';
import type { AppInstance } from '@/app/core/receiver.types';
import type { PagerLogEntry } from '@/app/decoders/types';
import { defaultCharset } from '@/worker/decoders/charsets';
import { applyPagerRxDefaults, pagerAutoScroll } from '@/app/decoders/pager';

/** FLEX-specific app mixin methods. FLEX is one pager protocol among peers
 * (POCSAG, GSC); the shared log/render/export lives in pager.ts. */
export const flexMethods = {
	/** Current FLEX charset value string for a VFO's <select> binding. */
	flexCharsetValue(this: AppInstance, i: number): string {
		const k = this.vfos[i]?.flexCharset ?? defaultCharset('flex');
		return `${k.vendor}\u0000${k.model}\u0000${k.codepage}`;
	},
	/** Apply a FLEX charset selection to a VFO and push it to the decoder.
	 * A handler charset (e.g. Kanji) changes decoding, not just a glyph table. */
	setFlexCharset(this: AppInstance, i: number, value: string) {
		const [vendor, model, codepage] = value.split('\u0000');
		this.vfos[i].flexCharset = { vendor, model, codepage };
		this.updateBackendVfoParams(i);
	},
	/** Decode-FLEX toggle. Applies the shared NFM-paging RX defaults on enable;
	 * FLEX needs the wider deviation of 4FSK, so the bandwidth matters. */
	toggleFlex(this: AppInstance, i: number) {
		applyPagerRxDefaults(this, i, this.vfos[i].flex);
	},
	_onFlexStatus(this: AppInstance, vfoIndex: number, freqMhz: number, status: FlexStatus) {
		if (!this.flexStatus) this.flexStatus = [];
		// Carry last-known BER forward so the UI can dim it during hunt.
		const prev = this.flexStatus[vfoIndex];
		const lastBer = status.ber != null ? status.ber : (prev?.lastBer ?? null);

		// Emit ERS and reserved sync codes as pager log entries (once per event).
		const prevEvent = prev?.lastSyncEvent;
		const curEvent = status.lastSyncEvent;
		if (curEvent && curEvent !== prevEvent && (!prevEvent || curEvent.code !== prevEvent.code || curEvent.label !== prevEvent.label)) {
			const time = new Date().toLocaleTimeString();
			const freq = freqMhz ? this.formatFreq(freqMhz) + ' MHz' : '';
			this.pager.log.push({
				protocol: 'flex',
				time,
				freq,
				vfoIndex,
				capcode: '',
				type: 'alpha',
				text: curEvent.ers
					? `ERS: ${curEvent.label} (emergency re-sync)`
					: `SYNC CODE: ${curEvent.label} [0x${curEvent.code.toString(16).padStart(4, '0')}]`,
				charStatus: [],
				baud: status.baud ?? undefined,
				inverted: status.inverted,
			});
			pagerAutoScroll(this);
		}

		this.flexStatus[vfoIndex] = Object.assign(status, { lastBer });
	},
	/** Format a VFO's FLEX timezone offset (minutes from UTC) as "UTC+HH:MM". */
	flexTzLabel(this: AppInstance, i: number): string {
		const min = this.flexStatus?.[i]?.tzOffsetMin;
		if (min == null) return '';
		const sign = min < 0 ? '-' : '+';
		const a = Math.abs(min);
		return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
	},
	/** Short UI label for a FLEX capcode class (special address ranges). */
	flexCapClassLabel(this: AppInstance, cls: string): string {
		const map: Record<string, string> = {
			infoSvc: 'MAILDROP',
			network: 'NID',
			temporary: 'GROUP',
			operMsg: 'SYSMSG',
			reserved: 'RSVD',
			unknown: '?',
		};
		return map[cls] ?? cls;
	},
	/** Format a FLEX member-capcode list, each zero-padded to 10 digits to match
	 * the CAP: column (FLEX max 4297068542 is 10 digits). */
	flexMembers(this: AppInstance, members: number[]): string {
		return members.map((m) => String(m).padStart(10, '0')).join(', ');
	},
	/** True when any FLEX group slot on this VFO is active (registered/delivering). */
	flexHasGroups(this: AppInstance, i: number): boolean {
		return (this.flexStatus?.[i]?.groupSlots ?? []).some((s) => s.state !== 'idle');
	},
	/** Cell color for a FLEX group-slot state in the mini-grid. */
	flexGroupCellColor(this: AppInstance, state: string): string {
		if (state === 'registered') return '#4a7dc4'; // blue
		if (state === 'delivering') return '#ffb74d'; // amber
		return 'rgba(255,255,255,0.12)'; // idle
	},
	/** Hover title for a FLEX group slot: #, state, target frame, members. */
	flexGroupSlotTitle(this: AppInstance, i: number, s: number): string {
		const slot = this.flexStatus?.[i]?.groupSlots?.[s];
		if (!slot) return `Slot ${s}: idle`;
		const parts = [`Slot ${s}`, slot.state];
		if (slot.targetFrame >= 0) parts.push(`frame ${slot.targetFrame}`);
		if (slot.members.length) parts.push(`members: ${this.flexMembers(slot.members)}`);
		return parts.join(' | ');
	},
	_onFlexMessage(this: AppInstance, vfoIndex: number, freqMhz: number, msg: FlexMessage) {
		const time = new Date().toLocaleTimeString();
		const freq = freqMhz ? this.formatFreq(freqMhz) + ' MHz' : '';
		const entry: PagerLogEntry = {
			protocol: 'flex',
			time,
			freq,
			vfoIndex,
			// FLEX capcodes are shown zero-padded to 10 digits (the long-address
			// maximum, 4297068542, is 10 digits) for aligned columns.
			capcode: String(msg.capcode).padStart(10, '0'),
			type: msg.kind.toLowerCase(),
			text: msg.text,
			charStatus: msg.charStatus ?? [],
			phase: msg.phase,
			flexCycle: msg.cycle,
			flexFrame: msg.frame,
			inverted: msg.inverted,
			frag: msg.frag,
			complete: msg.complete,
			sigOk: msg.sigOk,
			kOk: msg.kOk,
			mailDrop: msg.mailDrop,
			retrieval: msg.retrieval,
			msgNumber: msg.msgNumber,
			isNew: msg.isNew,
			capClass: msg.capClass,
			reasmKey: msg.reasmKey,
			fragCount: msg.fragCount,
			groupMembers: msg.groupMembers,
			incomplete: msg.incomplete,
			dedup: msg.dedup,
			flexBaud: msg.baud,
			flexLevels: msg.levels,
			flexTime: msg.flexTime,
		};
		// Fragmented messages carry a stable reasmKey. Update the existing
		// (still-incomplete) row in place so the message visibly builds up,
		// rather than appending a new row per fragment. A non-fragment message
		// (no reasmKey) always appends.
		let appended = false;
		if (msg.reasmKey) {
			const idx = this.pager.log.findIndex((e) => e.protocol === 'flex' && e.reasmKey === msg.reasmKey && !e.complete);
			if (idx >= 0) {
				entry.time = this.pager.log[idx].time; // keep the first-seen time
				this.pager.log[idx] = entry;
				appended = true;
			}
		}
		if (!appended) this.pager.log.push(entry);
		pagerAutoScroll(this);
	},
};
