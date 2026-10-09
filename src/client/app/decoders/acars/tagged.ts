import type { AcarsRecord } from '@/worker/decoders/acars/types';
import type { AcarsField, AcarsInterpretation } from './types';
import { messageTime } from './time';

const tags: Record<string, string> = {
	DEP: 'Departure',
	DES: 'Destination',
	DEST: 'Destination',
	DS: 'Destination',
	REG: 'Reported registration',
	FLT: 'Reported flight',
	FN: 'Reported flight',
	FOB: 'Fuel on board',
	GW: 'Gross weight',
	GWT: 'Gross weight',
	ZFW: 'Zero-fuel weight',
	ALT: 'Altitude',
	CAS: 'Calibrated airspeed',
	TAS: 'True airspeed',
	GS: 'Ground speed',
	SAT: 'Static air temperature',
	TAT: 'Total air temperature',
	WD: 'Wind direction',
	WS: 'Wind speed',
	UTC: 'Reported UTC time',
	ETA: 'Estimated arrival',
	DAY: 'Reported date',
};

function taggedField(tag: string, value: string, receivedAt: number): AcarsField | undefined {
	if (['DEP', 'DES', 'DEST', 'DS'].includes(tag)) return /^[A-Z]{3,4}$/.test(value) ? { label: tags[tag], value } : undefined;
	if (tag === 'UTC' || tag === 'ETA') {
		const format = value.length === 4 ? 'HHMM' : 'HHMMSS';
		if (messageTime(value, receivedAt, format) === undefined) return;
		return {
			label: tags[tag],
			value: `${value.slice(0, 2)}:${value.slice(2, 4)}${value.length === 6 ? `:${value.slice(4)}` : ''} ${tag === 'UTC' ? 'UTC' : '(timezone unspecified)'}`,
		};
	}
	if (['REG', 'FLT', 'FN', 'DAY'].includes(tag)) return /^[A-Z0-9-]{1,12}$/.test(value) ? { label: tags[tag], value } : undefined;
	return /^[+-]?\s*\d+(?:\.\d+)?$/.test(value) ? { label: `${tags[tag]} (${tag}, raw)`, value } : undefined;
}

export function interpretTagged(message: AcarsRecord): AcarsInterpretation | undefined {
	if (/^DAT\s/.test(message.text.trim())) return;
	// Explicit tagged fields generalize across airlines; require several markers to avoid interpreting ordinary prose.
	const tokens = [
		...message.text.matchAll(
			/(?:^|[\s/])(DEP|DES|DEST|DS|REG|FLT|FN|FOB|GW|GWT|ZFW|ALT|CAS|TAS|GS|SAT|TAT|WD|WS|UTC|ETA|DAY)[ /]+([^/\r\n]*?)(?=\s+(?:DEP|DES|DEST|DS|REG|FLT|FN|FOB|GW|GWT|ZFW|ALT|CAS|TAS|GS|SAT|TAT|WD|WS|UTC|ETA|DAY)[ /]|[\r\n/]|$)/g,
		),
	];
	const fields = tokens
		.map((match) => taggedField(match[1], match[2].trim(), message.receivedAt))
		.filter((field): field is AcarsField => field !== undefined);
	if (fields.length < 3) return;
	return {
		title: 'Tagged aircraft report',
		summary: fields
			.slice(0, 4)
			.map((field) => `${field.label}: ${field.value}`)
			.join(' · '),
		coverage: 'partial',
		fields,
		notes: ['Explicit field names were extracted. Numeric scale and units are not inferred; unrecognized text stays in the raw message.'],
	};
}
