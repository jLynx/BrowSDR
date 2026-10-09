import type { AcarsRecord } from '@/worker/decoders/acars/types';
import type { AcarsField, AcarsInterpretation } from './types';
import { timeFields } from './time';

const airports: Record<string, string> = { NZAA: 'Auckland Airport', ZBAA: 'Beijing Capital Airport' };
const airport = (code: string) => (airports[code] ? `${code} · ${airports[code]}` : code);
const routeFields = (departure: string, destination: string): AcarsField[] => [
	{ label: 'Departure', value: airport(departure) },
	{ label: 'Destination', value: airport(destination) },
];

export function interpretPosition(message: AcarsRecord): AcarsInterpretation | undefined {
	// Match the explicit hemisphere/decimal-degree/UTC layout, not every label-3L payload.
	const match = /^([NS])[ \t]*(\d{1,2}(?:\.\d+)?)[ \t]*\/[ \t]*([EW])[ \t]*(\d{1,3}(?:\.\d+)?)[ \t]*\/[ \t]*UTC[ \t]+(\d{4})$/.exec(
		message.text.trim(),
	);
	if (!match || message.direction !== 'downlink') return;
	const [, northSouth, latitude, eastWest, longitude, clock] = match;
	if (Number(latitude) > 90 || Number(longitude) > 180) return;
	const time = timeFields(clock, message.receivedAt, 'HHMM');
	if (!time.length) return;
	return {
		title: 'Position report',
		summary: `Reported position · ${latitude}° ${northSouth}, ${longitude}° ${eastWest} · ${clock.slice(0, 2)}:${clock.slice(2)} UTC.`,
		coverage: 'decoded',
		fields: [
			{ label: 'Latitude', value: `${latitude}° ${northSouth} (${northSouth === 'S' ? '-' : ''}${latitude}°)` },
			{ label: 'Longitude', value: `${longitude}° ${eastWest} (${eastWest === 'W' ? '-' : ''}${longitude}°)` },
			...time,
		],
		notes: ['Coordinates are decimal degrees. The event date is inferred from reception; the payload supplies UTC hour and minute only.'],
	};
}

export function interpretTakeoff(message: AcarsRecord): AcarsInterpretation | undefined {
	// Label 10 varies by airline. Recognize this OFF layout rather than assigning meanings to all label 10 messages.
	const match = /^OFF(\d{6}),([A-Z]{4}),([A-Z]{4}),([^,\r\n]*),([^,\r\n]*),LT,([^,\r\n]*),([^,\r\n]*)$/.exec(message.text.trim());
	if (!match || message.direction !== 'downlink') return;
	const [, clock, departure, destination] = match;
	const time = timeFields(clock, message.receivedAt, 'DDHHMM');
	if (!time.length) return;
	return {
		title: 'Wheels-off report',
		summary: `Takeoff reported · ${airport(departure)} → ${airport(destination)}.`,
		coverage: 'partial',
		fields: [{ label: 'Event', value: 'OFF · wheels off / airborne' }, ...routeFields(departure, destination), ...time],
		notes: ['The event date is inferred from reception. Additional airline-specific fields are retained in the raw message.'],
	};
}

export function interpretMonitoring(message: AcarsRecord): AcarsInterpretation | undefined {
	const match = /^01([A-Z]{4}) +([A-Z0-9]+)\/(\d{6})([A-Z]{4})([A-Z]{4})(?:\r?\n|$)/.exec(message.text.trim());
	if (!match || message.direction !== 'downlink') return;
	const [, code, flight, clock, departure, destination] = match;
	return {
		title: `Airline report ${code}`,
		summary: `${code} · ${flight} · ${airport(departure)} → ${airport(destination)}.`,
		coverage: 'partial',
		fields: [
			{ label: 'Report code', value: code },
			{ label: 'Reported flight', value: flight },
			...routeFields(departure, destination),
			{ label: 'Reported time code', value: clock },
			...timeFields(clock, message.receivedAt, 'DDHHMM'),
		],
		notes: [
			'The report code and numeric measurements use an airline-specific format; their meanings and units are not decoded.',
			'If shown, the event date is inferred from reception using a day/hour/minute time code.',
		],
	};
}

export function interpretDf(text: string): AcarsInterpretation {
	const header = /^<(\d+)>([A-Z0-9]+)/.exec(text);
	const route = header ? /\d([A-Z]{4})([A-Z]{4})\d+\s*$/m.exec(text) : null;
	const sections = [...text.matchAll(/(?:^|;)A(\d{2})(?=[+-])/g)].map((match) => `A${match[1]}`);
	return {
		title: header ? `Aircraft report ${header[2]}` : 'Aircraft report fragment',
		summary: header ? `DF report · ${header[2]} · report ID ${header[1]}.` : 'DF report fragment · numeric data retained as received.',
		coverage: header ? 'partial' : 'unknown',
		coverageDetail: header ? 'Header decoded · measurements undecoded' : 'Payload undecoded',
		fields: [
			...(header
				? [
						{ label: 'Report ID', value: header[1] },
						{ label: 'Report code', value: header[2] },
					]
				: []),
			...(route ? routeFields(route[1], route[2]) : []),
			...(sections.length ? [{ label: 'Numeric section identifiers (raw)', value: [...new Set(sections)].join(', ') }] : []),
		],
		notes: [
			'This DF payload is not decoded by the Airframes library or a supported report parser. Numeric sections need the aircraft report specification to assign meanings and units.',
			...(header ? [] : ['This block has no recognized report header. Continued blocks are displayed separately.']),
		],
	};
}
