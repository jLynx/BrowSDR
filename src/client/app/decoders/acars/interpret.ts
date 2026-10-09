import type { AcarsRecord } from '@/worker/decoders/acars/types';
import { interpretArinc } from './arinc';
import { interpretDf, interpretMonitoring, interpretTakeoff } from './reports';
import { timeFields } from './time';
import type { AcarsInterpretation } from './types';

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
	const match = /^0([EL])([A-Z0-9])(\d{6})([A-Z0-9]*)\/([^]*)$/.exec(message.text.trim());
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
	if (result) return result;
	if (['H1', 'AA', 'A6'].includes(message.label)) return interpretApplication(message);
	return unknown(message);
}

function interpretApplication(message: AcarsRecord): AcarsInterpretation {
	let text = message.text.trim();
	const sublabel = message.label === 'H1' ? (message.direction === 'downlink' ? /^#([A-Z0-9]{2})B/ : /^- #([A-Z0-9]{2})/).exec(text) : null;
	if (sublabel) text = text.slice(sublabel[0].length);
	const mfi = sublabel ? /^\/([A-Z0-9]{2}) /.exec(text) : null;
	if (mfi) text = text.slice(mfi[0].length);
	const result = interpretArinc(text) ?? (sublabel?.[1] === 'DF' ? interpretDf(text) : unknown(message));
	result.fields.unshift(
		...(sublabel ? [{ label: 'H1 sublabel', value: sublabel[1] }] : []),
		...(mfi ? [{ label: 'Message function', value: mfi[1] }] : []),
	);
	return result;
}

function unknown(message: AcarsRecord): AcarsInterpretation {
	return {
		title: 'Unparsed message',
		summary: message.text ? 'No supported payload format matched. Open the message to read the original text.' : 'Empty message body.',
		coverage: 'unknown',
		fields: [],
		notes: ['The ACARS label alone does not define every airline payload. The original message is preserved below.'],
	};
}

export function interpretAcars(message: AcarsRecord): AcarsInterpretation {
	const interpretation = interpretPayload(message);
	if (message.continuation) interpretation.notes.push('This block continues in another transmission (ETB); blocks are not reassembled.');
	return interpretation;
}
