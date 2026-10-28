import type { AppInstance } from '@/app/core/receiver.types';
import type { PagerLogEntry } from '@/app/decoders/types';
import { CHARSETS, hasCharsets } from '@/worker/decoders/charsets';
import type { PagerProtocol } from '@/worker/decoders/charsets';

/** Static descriptor for each pager protocol the UI can present. POCSAG, GSC
 * and FLEX are peers; `hasCharsets` is resolved from the registry so a
 * default-only protocol (GSC) never shows a charset selector. */
export const PAGER_PROTOCOLS: Array<{ id: PagerProtocol | 'rds' | 'tmc'; label: string }> = [
	{ id: 'pocsag', label: 'POCSAG' },
	{ id: 'gsc', label: 'GSC' },
	{ id: 'flex', label: 'FLEX' },
	{ id: 'rds', label: 'RDS' },
	{ id: 'tmc', label: 'TMC' },
];

/**
 * Represent one decoded character for the log display (after charset
 * conversion): newline and carriage return both show as the Unicode return
 * symbol (they are line/message separators), other control / non-printable
 * codes as <0xNN>. Printable glyphs (incl. codepage glyphs) pass through
 * unchanged. CR must stay visible: dropping it merges HELLO/WORLD into
 * HELLOWORLD in both the display and the text export.
 */
export function pagerDisplayChar(ch: string): string {
	const code = ch.charCodeAt(0);
	if (ch === '\n' || ch === '\r') return '\u23ce';
	if (code < 0x20 || code === 0x7f) return `<0x${code.toString(16).padStart(2, '0').toUpperCase()}>`;
	return ch;
}

/** Apply pagerDisplayChar across a whole string. */
export function pagerDisplayText(text: string): string {
	let out = '';
	for (const ch of text) out += pagerDisplayChar(ch);
	return out;
}

/** One line of the plain-text pager export. POCSAG carries a function
 * sub-address (A-D); GSC does not (its function is in the address suffix), so
 * the F: field is POCSAG-only. GSC voice pages show their start/stop event. */
export function formatPagerExportLine(e: PagerLogEntry): string {
	const head = `[${e.time}] ${e.protocol.toUpperCase()}  ${e.freq}  CAP:${e.capcode}`;
	const func = e.protocol === 'pocsag' ? `  F:${['A', 'B', 'C', 'D'][e.func ?? -1] || '?'}` : '';
	let body: string;
	if (e.voiceEvent === 'start') body = 'VOICE START';
	else if (e.voiceEvent === 'stop') body = `VOICE END${e.voiceEndReason ? ` (${e.voiceEndReason})` : ''}`;
	else body = e.text ? pagerDisplayText(e.text) : '(tone)';
	const alt = e.alt && e.alt.text ? `  (${e.alt.type}: ${pagerDisplayText(e.alt.text)})` : '';
	const dbg = e.detectDebug ? `  [${e.detectDebug}]` : '';
	return `${head}${func}  TYPE:${e.type}  ${body}${alt}${dbg}`;
}

/** Apply the NFM-paging-friendly RX default a pager decoder wants on enable:
 * disable the speech low-pass (it rounds the FSK edges). The channel bandwidth
 * is NOT forced here any more: each enabled pager is demodulated on its own
 * channel leg at the protocol's RX bandwidth (see pager-bandwidth.ts), so the
 * main VFO bandwidth stays the operator's own (voice) setting. Visible,
 * user-overridable; left as-is on disable so the user keeps whatever they had.
 * Shared by every protocol toggle (POCSAG/GSC/FLEX). */
export function applyPagerRxDefaults(app: AppInstance, i: number, enabled: boolean): void {
	const vfo = app.vfos[i];
	if (enabled) {
		vfo.lowPass = false;
	}
	app.updateBackendVfoParams(i);
}

/** Scroll the pager log to the newest row after Vue flushes the DOM. Shared by
 * every protocol's message handler. */
export function pagerAutoScroll(app: AppInstance): void {
	Promise.resolve(
		app.$nextTick(() => {
			const el = app.$refs.pagerBody;
			if (el) el.scrollTop = el.scrollHeight;
		}),
	).catch((error: unknown) => console.error(error));
}

export const pagerMethods = {
	togglePagerPanel(this: AppInstance) {
		this.pager.panelOpen = !this.pager.panelOpen;
	},
	/** List of pager protocols for the per-VFO multi-select. */
	pagerProtocols(this: AppInstance): Array<{ id: PagerProtocol | 'rds' | 'tmc'; label: string; hasCharsets: boolean }> {
		return PAGER_PROTOCOLS.map((p) => ({ ...p, hasCharsets: p.id !== 'rds' && p.id !== 'tmc' && hasCharsets(p.id) }));
	},
	/** Set the panel's protocol row filter. */
	setPagerFilter(this: AppInstance, value: string) {
		this.pager.filter = (value as PagerProtocol | 'rds' | 'tmc' | 'all') ?? 'all';
	},
	/** Panel rows after applying the protocol filter. */
	pagerRows(this: AppInstance): PagerLogEntry[] {
		const f = this.pager.filter;
		return f === 'all' ? this.pager.log : this.pager.log.filter((e) => e.protocol === f);
	},
	/** All selectable charsets for a protocol, grouped by vendor, for the UI
	 * dropdown. Data-driven off the registry so each protocol shows only its own
	 * codepages (POCSAG and FLEX; GSC is default-only, so it lists none). */
	pagerCharsetGroups(
		this: AppInstance,
		protocol: PagerProtocol,
	): Array<{ vendor: string; items: Array<{ value: string; label: string }> }> {
		const groups = new Map<string, Array<{ value: string; label: string }>>();
		for (const e of CHARSETS[protocol] ?? []) {
			const value = `${e.vendor}\u0000${e.model}\u0000${e.codepage}`;
			if (!groups.has(e.vendor)) groups.set(e.vendor, []);
			groups.get(e.vendor)!.push({ value, label: e.label });
		}
		return [...groups.entries()].map(([vendor, items]) => ({ vendor, items }));
	},
	/** Format a decoded string for the log (control chars -> return / <0xNN>). */
	pagerDisplayText(this: AppInstance, text: string): string {
		return pagerDisplayText(text);
	},
	/**
	 * Split a message's text into contiguous runs of the same decode status so
	 * the template can colour-code each run (ok / corrected / uncorrectable)
	 * with a single span per run instead of one span per character.
	 */
	pagerSegments(this: AppInstance, entry: PagerLogEntry): Array<{ text: string; status: number }> {
		const { text, charStatus } = entry;
		if (!charStatus || charStatus.length === 0) return [{ text: pagerDisplayText(text), status: 0 }];
		const segments: Array<{ text: string; status: number }> = [];
		let cur = '';
		let curStatus = charStatus[0] ?? 0;
		for (let i = 0; i < text.length; i++) {
			const st = charStatus[i] ?? 0;
			if (st !== curStatus && cur) {
				segments.push({ text: cur, status: curStatus });
				cur = '';
				curStatus = st;
			} else if (st !== curStatus) {
				curStatus = st;
			}
			cur += pagerDisplayChar(text[i]);
		}
		if (cur) segments.push({ text: cur, status: curStatus });
		return segments;
	},
	clearPager(this: AppInstance) {
		this.pager.log = [];
	},
	exportPager(this: AppInstance) {
		const lines = this.pager.log.map((e) => formatPagerExportLine(e));
		const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `pager-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
		a.click();
		URL.revokeObjectURL(url);
	},
};
