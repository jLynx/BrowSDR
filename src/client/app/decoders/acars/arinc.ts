import type { AcarsInterpretation } from './types';

const applications: Record<string, { title: string; summary: string }> = {
	AT1: { title: 'CPDLC message', summary: 'Controller–pilot data link message.' },
	CR1: { title: 'CPDLC connection request', summary: 'A request to establish a controller–pilot data link connection.' },
	CC1: { title: 'CPDLC connection confirmation', summary: 'Confirmation of a controller–pilot data link connection.' },
	DR1: { title: 'CPDLC disconnect request', summary: 'A request to end a controller–pilot data link connection.' },
	ADS: { title: 'ADS-C message', summary: 'Automatic dependent surveillance–contract data exchanged with a ground station.' },
	DIS: { title: 'ADS-C disconnect request', summary: 'A request to end an ADS-C connection.' },
};

export function interpretArinc(text: string): AcarsInterpretation | undefined {
	// ARINC 622 uses a fixed seven-character aircraft address, including dot/space padding.
	const match = /^\/?([A-Z0-9]{4}|[A-Z0-9]{7})\.(AT1|CR1|CC1|DR1|ADS|DIS)([. A-Z0-9-]{7})([A-F0-9]+)$/.exec(text.trim());
	if (!match || match[4].length < 4 || match[4].length % 2 !== 0) return;
	const [, ground, application, aircraft, binary] = match;
	return {
		...applications[application],
		coverage: 'partial',
		fields: [
			{ label: 'Application', value: `${application} · ARINC 622` },
			{ label: 'Ground address', value: ground },
			{ label: 'Aircraft address', value: aircraft.replace(/^[. ]+|[. ]+$/g, '') },
			{ label: 'Application data (hex)', value: binary.slice(0, -4) || '(Empty)' },
			{ label: 'Application CRC (unchecked)', value: binary.slice(-4) },
		],
		notes: ['The application envelope is recognized. The binary application data is not decoded, and its inner CRC is not checked.'],
	};
}
