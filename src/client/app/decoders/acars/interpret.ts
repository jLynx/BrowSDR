import type { AcarsRecord } from '@/worker/decoders/acars/types';
import { interpretArinc } from './arinc';
import { interpretAirbus, interpretLoad, interpretOperations } from './airline';
import { interpretDf, interpretMonitoring, interpretPosition, interpretTakeoff } from './reports';
import { timeFields } from './time';
import type { AcarsInterpretation } from './types';
import { interpretCommunity } from './community';
import { interpretEvent } from './events';
import { labelDescription } from './catalogue';
import { interpretTagged } from './tagged';
import { interpretText } from './protocols/text';
import { interpretAcm } from './protocols/monitoring';

const links: Record<string, string> = {
	V: 'VHF ACARS',
	S: 'Default SATCOM',
	H: 'HF',
	G: 'Globalstar SATCOM',
	C: 'ICO SATCOM',
	'2': 'VDL Mode 2',
	X: 'Inmarsat Aero',
	I: 'Iridium',
};
const linkName = (code: string) => links[code] ?? `Unknown link (${code})`;

function interpretAdvisory(message: AcarsRecord): AcarsInterpretation | undefined {
	const match = /^0([EL])([A-Z0-9])(\d{6})([A-Z0-9]*)(?:\/([^]*))?$/.exec(message.text.trim());
	if (!match) return;
	const [, state, current, clock, available, trailing] = match;
	const time = timeFields(clock, message.receivedAt, 'HHMMSS');
	if (!time.length) return;
	const status = state === 'E' ? 'established' : 'lost';
	return {
		title: 'Link advisory',
		summary: `${linkName(current)} link ${status}${available ? ` · available: ${[...available].map(linkName).join(', ')}` : ''}.`,
		coverage: [current, ...available].every((code) => links[code]) ? 'decoded' : 'partial',
		fields: [
			{ label: 'Link status', value: status },
			{ label: 'Current link', value: linkName(current) },
			{ label: 'Available links', value: [...available].map(linkName).join(', ') || 'None reported' },
			...time,
			...(trailing ? [{ label: 'Additional text', value: trailing }] : []),
		],
		notes: ['The event date is inferred from reception; the payload supplies only UTC time.'],
	};
}

function interpretPayload(message: AcarsRecord): AcarsInterpretation {
	if (message.label === '_d') {
		const negative = message.acknowledgement === 'NAK';
		return {
			title: negative ? 'Negative acknowledgement' : 'Acknowledgement',
			summary: negative ? 'The previous block was not acknowledged.' : `Acknowledges receipt of block ${message.acknowledgement}.`,
			coverage: 'decoded',
			fields: [{ label: 'Acknowledged block', value: message.acknowledgement }],
			notes: ['This is a link-control message. An empty text body is normal.'],
		};
	}
	let result: AcarsInterpretation | undefined;
	if (message.label === 'SA') result = interpretAdvisory(message);
	if (message.label === '10') result = interpretTakeoff(message);
	if (message.label === '49') result = interpretMonitoring(message);
	if (message.label === '3L') result = interpretPosition(message);
	if (message.label === '1L') result = interpretOperations(message);
	if (message.label === '2L') result = interpretLoad(message);
	if (result) return result;
	const binary = interpretArinc(message.text, message.direction);
	if (binary) return binary;
	if (['H1', 'AA', 'A6', 'BA'].includes(message.label)) return interpretApplication(message);
	const event = interpretEvent(message);
	if (['QP', 'QQ', 'QR', 'QS'].includes(message.label)) {
		if (!event) return unknown(message);
		return event.fields.some((field) => field.value === 'Not reported') ? event : (interpretCommunity(message) ?? event);
	}
	return event ?? interpretFallback(message);
}

function interpretFallback(message: AcarsRecord): AcarsInterpretation {
	return interpretText(message) ?? interpretCommunity(message) ?? interpretTagged(message) ?? unknown(message);
}

function interpretApplication(message: AcarsRecord): AcarsInterpretation {
	let text = message.text.trim();
	const sublabel = message.label === 'H1' ? (message.direction === 'downlink' ? /^#([A-Z0-9]{2})B/ : /^- #([A-Z0-9]{2})/).exec(text) : null;
	if (sublabel) text = text.slice(sublabel[0].length);
	const mfi = sublabel ? /^\/([A-Z0-9]{2}) /.exec(text) : null;
	if (mfi) text = text.slice(mfi[0].length);
	const result =
		interpretArinc(text, message.direction) ??
		(sublabel?.[1] === 'DF' ? (interpretAirbus(text, message.receivedAt) ?? interpretAcm(text)) : undefined) ??
		interpretText({ ...message, text }) ??
		interpretCommunity(message, text, sublabel?.[1]) ??
		(sublabel?.[1] === 'DF' ? interpretDf(text) : undefined) ??
		interpretTagged({ ...message, text }) ??
		unknown(message);
	result.fields.unshift(
		...(sublabel ? [{ label: 'H1 sublabel', value: sublabel[1] }] : []),
		...(mfi ? [{ label: 'Message function', value: mfi[1] }] : []),
	);
	return result;
}

function unknown(message: AcarsRecord): AcarsInterpretation {
	const label = labelDescription(message.label);
	return {
		title: label?.title ?? 'Unparsed message',
		summary:
			label?.description ??
			(message.text ? 'No documented label or payload format matched. The original text is available below.' : 'Empty message body.'),
		coverage: 'unknown',
		fields: label ? [{ label: 'Message category', value: label.title }] : [],
		notes: [
			...(message.label === 'MA' || /OHMA/.test(message.text)
				? ['Compressed application transfers are not expanded by this viewer. The transmitted data is preserved.']
				: []),
			label
				? 'The label category is recognized. This payload layout is not decoded; the original text is preserved.'
				: 'The airline or application may use a proprietary format. The original message is preserved.',
		],
	};
}

export function interpretAcars(message: AcarsRecord): AcarsInterpretation {
	const interpretation =
		message.label === 'Q0' && !message.text.trim()
			? {
					title: 'Link test',
					summary: 'An ACARS link check; an empty body is normal.',
					coverage: 'decoded' as const,
					fields: [],
					notes: [],
				}
			: interpretPayload(message);
	if (message.continuation)
		interpretation.notes.push(
			'This block continues in another transmission (ETB); blocks are not reassembled until every consecutive block and the final ETX arrive.',
		);
	return interpretation;
}
