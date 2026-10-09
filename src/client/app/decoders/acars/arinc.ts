import type { AcarsInterpretation } from './types';
import { hexBytes, validArincCrc } from './protocols/bits';
import { decodeAdsc } from './protocols/adsc';
import { decodeCpdlc } from './protocols/cpdlc';
import type { ApplicationDecode } from './protocols/types';

const applications: Record<string, { title: string; summary: string }> = {
	AT1: { title: 'CPDLC message', summary: 'Controller–pilot data link message.' },
	CR1: { title: 'CPDLC connection request', summary: 'A request to establish a controller–pilot data link connection.' },
	CC1: { title: 'CPDLC connection confirmation', summary: 'Confirmation of a controller–pilot data link connection.' },
	DR1: { title: 'CPDLC disconnect request', summary: 'A request to end a controller–pilot data link connection.' },
	ADS: { title: 'ADS-C message', summary: 'Automatic dependent surveillance–contract data exchanged with a ground station.' },
	DIS: { title: 'ADS-C disconnect request', summary: 'A request to end an ADS-C connection.' },
};
const cache = new Map<string, AcarsInterpretation | undefined>();

export function interpretArinc(text: string, direction: 'uplink' | 'downlink' = 'downlink'): AcarsInterpretation | undefined {
	if (text.length > 8192 || !/\.(AT1|CR1|CC1|DR1|ADS|DIS)/.test(text)) return;
	const key = `${direction}\0${text}`;
	if (!cache.has(key)) {
		if (cache.size >= 400) cache.delete(cache.keys().next().value!);
		cache.set(key, parseArinc(text, direction));
	}
	return structuredClone(cache.get(key));
}

function parseArinc(text: string, direction: 'uplink' | 'downlink'): AcarsInterpretation | undefined {
	// ARINC 622 uses a fixed seven-character aircraft address, including dot/space padding.
	const match = /^(?:[A-Z0-9]{3,12}\/|\/)?([A-Z0-9]{4}|[A-Z0-9]{7})\.(AT1|CR1|CC1|DR1|ADS|DIS)([. A-Z0-9-]{7})([A-F0-9]+)$/.exec(
		text.trim(),
	);
	if (!match || match[4].length < 4 || match[4].length % 2 !== 0) return;
	const [, ground, application, aircraft, binary] = match;
	const valid = validArincCrc(application + aircraft, hexBytes(binary));
	const result: AcarsInterpretation = {
		...applications[application],
		coverage: 'partial',
		fields: [
			{ label: 'Application', value: `${application} · ARINC 622` },
			{ label: 'Ground address', value: ground },
			{ label: 'Aircraft address', value: aircraft.replace(/^[. ]+|[. ]+$/g, '') },
			{ label: 'Application data (hex)', value: binary.slice(0, -4) || '(Empty)' },
			{ label: 'Application CRC', value: `${binary.slice(-4)} · ${valid ? 'Verified' : 'Failed'}` },
		],
		notes: [
			valid
				? 'Application CRC verified over the transmitted address and binary data.'
				: 'Application CRC failed. The envelope is shown; binary values are not decoded.',
		],
	};
	if (!valid) return result;
	try {
		const bytes = hexBytes(binary).slice(0, -2);
		let decoded: ApplicationDecode | undefined;
		if (application === 'ADS') decoded = decodeAdsc(bytes, direction);
		if (application === 'AT1') decoded = decodeCpdlc(bytes, direction);
		// CR1 embeds an uplink PDU regardless of the surrounding ACARS direction.
		if (application === 'CR1') decoded = decodeCpdlc(bytes, 'uplink');
		if (application === 'DIS' && bytes.length === 1) {
			decoded = {
				fields: [{ label: 'Disconnect reason code', value: String(bytes[0]) }],
				summary: 'ADS-C disconnect request.',
				complete: true,
				notes: [],
			};
		}
		if (decoded) {
			result.fields.push(...decoded.fields);
			result.summary = decoded.summary;
			result.coverage = decoded.complete ? 'decoded' : 'partial';
			result.notes.push(...decoded.notes);
			result.fields.push({
				label: 'Payload parser',
				value: application === 'ADS' ? 'BrowSDR · libacars / datalink ADS-C' : 'BrowSDR · datalink FANS CPDLC',
			});
		} else result.notes.push('The binary application body is preserved; this control-body layout is not decoded.');
	} catch {
		result.notes.push('The binary application data is truncated, invalid or uses an unsupported layout; it is not decoded.');
	}
	return result;
}
