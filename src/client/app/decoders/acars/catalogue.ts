import type { AcarsLabel } from './types';
import labels from './reference/labels.json';

/** Label categories describe the envelope, not a guaranteed airline payload layout. */
export const ACARS_LABELS: Record<string, AcarsLabel> = {
	_d: { title: 'Acknowledgement', description: 'Acknowledges an ACARS block; an empty text body is normal.' },
	':;': { title: 'Frequency change', description: 'Aircraft transceiver frequency change.' },
	Q0: { title: 'Link test', description: 'Tests the ACARS link; an empty body is normal.' },
	Q1: { title: 'Flight event report', description: 'Reports out, off, on and in flight events.' },
	Q2: { title: 'ETA report', description: 'Reports an estimated arrival time.' },
	QA: { title: 'Out report', description: 'Reports departure from the gate.' },
	QB: { title: 'Off report', description: 'Reports takeoff / wheels off.' },
	QC: { title: 'On report', description: 'Reports landing / wheels on.' },
	QD: { title: 'In report', description: 'Reports arrival at the gate.' },
	QE: { title: 'Out / destination report', description: 'Reports gate departure and destination.' },
	QF: { title: 'Off / destination report', description: 'Reports takeoff and destination.' },
	QG: { title: 'Out / in report', description: 'Reports gate departure and return.' },
	QH: { title: 'Out report', description: 'Reports gate departure using an alternate layout.' },
	QK: { title: 'On / destination report', description: 'Reports landing and destination.' },
	QL: { title: 'In / route report', description: 'Reports gate arrival and route information.' },
	QM: { title: 'Route report', description: 'Reports origin and destination.' },
	QN: { title: 'ETA / destination report', description: 'Reports an estimated arrival time and destination.' },
	QP: { title: 'Out / route report', description: 'Reports gate departure, origin and destination.' },
	QQ: { title: 'Off / route report', description: 'Reports takeoff, origin and destination.' },
	QR: { title: 'On / route report', description: 'Reports landing, origin and destination.' },
	QS: { title: 'In / route report', description: 'Reports gate arrival, origin and destination.' },
	QT: { title: 'Out / in / route report', description: 'Reports gate events, origin and destination.' },
	RA: { title: 'Ground text message', description: 'Ground-to-air text; the airline defines the contents.' },
	RB: { title: 'Command / response', description: 'A command or response exchanged with an aircraft application.' },
	SA: { title: 'Link advisory', description: 'Reports communications link status and available media.' },
	SQ: { title: 'Ground station squitter', description: 'A ground station broadcast identifying available service.' },
	MA: { title: 'MIAM message', description: 'An ACARS application transfer or media message; contents may be compressed.' },
	'5D': { title: 'ATIS request', description: 'Requests airport terminal information; payload layouts vary by application.' },
	'5V': { title: 'VDL switch advisory', description: 'An advisory about switching the VHF data link. An empty body is normal.' },
	H1: { title: 'Terminal / aircraft application message', description: 'A message to or from an aircraft terminal or application.' },
	H2: { title: 'Aircraft application report', description: 'An aircraft application report; layout depends on equipment and airline.' },
	HX: { title: 'Undelivered message report', description: 'Reports a message that could not be delivered.' },
	A1: { title: 'Oceanic clearance', description: 'An oceanic clearance message; application identifiers determine its exact purpose.' },
	B0: { title: 'ATS facilities notification', description: 'An aircraft logon / contact message for an air traffic services unit.' },
	B1: { title: 'Oceanic clearance request', description: 'Requests an oceanic clearance.' },
	B2: { title: 'Oceanic clearance acknowledgement', description: 'Acknowledges an oceanic clearance.' },
	B3: { title: 'Departure clearance request', description: 'Requests a departure clearance.' },
	B4: { title: 'Departure clearance readback', description: 'Acknowledges or reads back a departure clearance.' },
	B6: { title: 'ATIS request', description: 'Requests automatic terminal information service information.' },
	BA: { title: 'ATC data link message', description: 'Air traffic control application data, including CPDLC envelopes.' },
	AA: { title: 'ATC data link message', description: 'An air traffic services application message.' },
	A6: {
		title: 'Surveillance / ATC data link message',
		description: 'An air traffic services application message, including ADS-C envelopes.',
	},
};

export function labelDescription(label: string): AcarsLabel | undefined {
	if (Object.hasOwn(ACARS_LABELS, label)) return ACARS_LABELS[label];
	if (Object.hasOwn(labels, label)) {
		const uses = labels[label as keyof typeof labels];
		return {
			title: `ACARS message (${label})`,
			description: `Documented label uses: ${uses.join('; ')}. The application defines the payload layout.`,
		};
	}
	if (/^[1-8][0-9A-Z]$/.test(label)) {
		return { title: `Airline message (${label})`, description: 'The airline or aircraft application defines this label’s payload format.' };
	}
	return;
}
