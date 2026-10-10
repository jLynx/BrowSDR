import { MessageDecoder } from '@airframes/acars-decoder';
import { isRecord } from '@/platform/data';
import type { AcarsRecord } from '@/worker/decoders/acars/types';
import type { AcarsField, AcarsInterpretation, CommunityItem, CommunityResult } from './types';

const decoder = new MessageDecoder();
const cache = new Map<string, AcarsInterpretation | undefined>();
export const COMMUNITY_FORMATS = decoder.plugins.length;
const titles: Record<string, string> = {
	'label-4a': 'Flight status report',
	'label-4a-01': 'Aircraft report',
	'label-4a-dis': 'Dispatch message',
	'label-4a-door': 'Door event report',
	'label-4a-slash-01': 'Aircraft application message',
	'label-4n': 'Aircraft report',
	'label-83': 'Position report',
	'label-5z-slash': 'Airline text message',
};

function validResult(value: unknown): value is CommunityResult {
	if (!isRecord(value) || !isRecord(value.decoder) || !isRecord(value.formatted) || !isRecord(value.raw) || !isRecord(value.remaining))
		return false;
	return (
		value.decoded === true &&
		typeof value.decoder.name === 'string' &&
		typeof value.decoder.decodeLevel === 'string' &&
		typeof value.formatted.description === 'string' &&
		Array.isArray(value.formatted.items) &&
		value.formatted.items.every(
			(item: unknown) => isRecord(item) && ['type', 'code', 'label', 'value'].every((key) => typeof item[key] === 'string'),
		)
	);
}

function formatItem(item: CommunityItem): AcarsField | undefined {
	if (!item.value || /NaN|Infinity/.test(item.value) || item.value === 'Unknown') return;
	if (/unknown/i.test(item.type) || /unknown/i.test(item.label)) return { label: 'Uninterpreted field', value: item.value };
	// The community decoder can supply a time of day or an explicit date. Do not invent a date for time-only values.
	if (item.type === 'time' || /^\d{2}:\d{2}:\d{2}$/.test(item.value)) {
		const clock = /^(\d{2}):(\d{2}):(\d{2})$/.exec(item.value);
		if (clock && (Number(clock[1]) > 23 || Number(clock[2]) > 59 || Number(clock[3]) > 59)) return;
		return { label: item.label, value: `${item.value}${clock ? ' UTC (date not supplied)' : ''}` };
	}
	return { label: item.label, value: item.value };
}

function convert(result: CommunityResult): AcarsInterpretation | undefined {
	const position = result.raw.position;
	if (
		isRecord(position) &&
		(!Number.isFinite(position.latitude) ||
			!Number.isFinite(position.longitude) ||
			Math.abs(Number(position.latitude)) > 90 ||
			Math.abs(Number(position.longitude)) > 180)
	)
		return;
	const fields = result.formatted.items
		.map(formatItem)
		.filter((field): field is AcarsField => field !== undefined)
		.slice(0, 80);
	if (!fields.length) return;
	const remainder = result.remaining.text;
	const unknown = fields.some((field) => field.label === 'Uninterpreted field') || fields.length !== result.formatted.items.length;
	const title =
		titles[result.decoder.name] ??
		(result.formatted.description === 'Unknown' ? 'Aircraft application report' : result.formatted.description);
	const binary = /CPDLC/i.test(title);
	return {
		title,
		summary: `${title} · ${fields
			.filter((field) => field.label !== 'Uninterpreted field')
			.slice(0, 3)
			.map((field) => `${field.label}: ${field.value}`)
			.join(' · ')}`,
		coverage: result.decoder.decodeLevel === 'full' && !remainder && !unknown && !binary ? 'decoded' : 'partial',
		fields,
		notes: [
			`Format identified by Airframes (${result.decoder.name}). Values and units follow that documented format.`,
			...(remainder ? ['Some application fields remain uninterpreted; the complete original message is retained.'] : []),
			...(fields.some((field) => /checksum/i.test(field.label))
				? ['Application checksum is shown as extracted; this viewer does not verify it.']
				: []),
			...(binary ? ['The application data is retained; binary CPDLC instructions are not decoded.'] : []),
		],
	};
}

export function interpretCommunity(message: AcarsRecord, text = message.text, sublabel?: string): AcarsInterpretation | undefined {
	// Compressed application transfers need a bounded asynchronous decoder before enabling inflation in the UI.
	if (message.label === 'MA' || /OHMA/.test(text) || text.length > 8192 || !text.trim()) return;
	if (message.label === 'SQ' && !/^V\d[A-Z]{2}/.test(text)) return;
	const key = `${message.label}\0${sublabel ?? ''}\0${text}`;
	if (cache.has(key)) return structuredClone(cache.get(key));
	let interpretation: AcarsInterpretation | undefined;
	try {
		const result: unknown = decoder.decode({ label: message.label, sublabel, text }, { debug: false });
		if (validResult(result)) interpretation = convert(result);
	} catch {
		// A malformed payload must not prevent reception or the rest of the message list from rendering.
	}
	if (cache.size >= 400) cache.delete(cache.keys().next().value!);
	cache.set(key, interpretation);
	return structuredClone(interpretation);
}
