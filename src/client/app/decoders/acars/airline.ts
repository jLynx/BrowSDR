import type { AcarsRecord } from '@/worker/decoders/acars/types';
import type { AcarsField, AcarsInterpretation } from './types';
import { datedTime, monthDayTime, timestampFields } from './time';

export function interpretOperations(message: AcarsRecord): AcarsInterpretation | undefined {
	const match = /^WX +RCVD +TXOPS +NORMAL *ETA +([A-Z]{3}) +(\d{4})$/.exec(message.text.trim());
	if (!match || message.direction !== 'downlink') return;
	const [, destination, eta] = match;
	if (Number(eta.slice(0, 2)) > 23 || Number(eta.slice(2)) > 59) return;
	const airport = destination === 'MEL' ? 'MEL · Melbourne Airport' : destination;
	const clock = `${eta.slice(0, 2)}:${eta.slice(2)}`;
	return {
		title: 'Operations message',
		summary: `Weather received · operations normal · ETA ${airport} ${clock} (timezone unspecified).`,
		coverage: 'partial',
		fields: [
			{ label: 'Weather', value: 'WX RCVD · weather received' },
			{ label: 'Operations', value: 'Normal' },
			{ label: 'Destination', value: airport },
			{ label: 'Estimated arrival', value: `${clock} · timezone unspecified` },
		],
		notes: ['This is an airline operations note. The TX token is not expanded; the ETA supplies neither a date nor a timezone.'],
	};
}

export function interpretLoad(message: AcarsRecord): AcarsInterpretation | undefined {
	const match =
		/^DAT +(\d{2}[A-Z]{3}\d{2}) +UTC +(\d{4}) +REG +([A-Z0-9-]+) +FLT +([A-Z0-9]+) +GWT +(\d+) +ZFW +(\d+) +FOB +(\d+) +CAP +(\d+) +FO +(\d+) +LOG +(\d+) +LDR +(\d+) +DRT +(\d{4})$/.exec(
			message.text.trim(),
		);
	if (!match || message.direction !== 'downlink') return;
	const [, date, clock, registration, flight, gross, zeroFuel, fuel, captain, firstOfficer, log, ldr, drt] = match;
	const timestamp = datedTime(date, clock);
	if (timestamp === undefined) return;
	return {
		title: 'Flight/load report',
		summary: `${flight} · ${registration} · zero-fuel weight ${zeroFuel}, fuel on board ${fuel} (raw values; units unspecified).`,
		coverage: 'partial',
		fields: [
			{ label: 'Reported registration', value: registration },
			{ label: 'Reported flight', value: flight },
			...timestampFields(timestamp, true),
			{ label: 'Gross weight (GWT, raw)', value: gross },
			{ label: 'Zero-fuel weight (ZFW, raw)', value: zeroFuel },
			{ label: 'Fuel on board (FOB, raw)', value: fuel },
			{ label: 'Captain identifier (CAP)', value: captain },
			{ label: 'First officer identifier (FO)', value: firstOfficer },
			{ label: 'LOG (raw)', value: log },
			{ label: 'LDR (raw)', value: ldr },
			{ label: 'DRT (raw)', value: drt },
		],
		notes: [
			'Weight and fuel values have no verified scale or units. A zero value is retained as reported and may be a placeholder.',
			'LOG, LDR and DRT meanings are not decoded. Numeric crew identifiers are not names. The two-digit year is interpreted as 2000–2099.',
		],
	};
}

export function interpretAirbus(text: string, receivedAt: number): AcarsInterpretation | undefined {
	const compact = interpretCompactAirbus(text);
	if (compact) return compact;
	const header =
		/^(A\d{3}),([^/]+)\/REP(\d+),([^/]+)\/CC([A-Z0-9-]+),([A-Z]{3}\d{2}),(\d{6}),([A-Z]{4}),([A-Z]{4}),([A-Z0-9]+)(?:\/|$)/.exec(text);
	if (!header) return;
	const [, type, configuration, report, reportHeader, registration, date, clock, departure, destination, flight] = header;
	const timestamp = monthDayTime(date, clock, receivedAt);
	if (timestamp === undefined) return;
	const airport = (code: string) => ({ NZAA: 'NZAA · Auckland Airport', NZCH: 'NZCH · Christchurch Airport' })[code] ?? code;
	return {
		title: `${type} aircraft report ${report}`,
		summary: `${type} · ${registration} · ${airport(departure)} → ${airport(destination)} · report ${report}.`,
		coverage: 'partial',
		coverageDetail: 'Header decoded · measurements undecoded',
		fields: [
			{ label: 'Aircraft type', value: type },
			{ label: 'Report ID', value: report },
			{ label: 'Reported registration', value: registration },
			{ label: 'Reported flight code', value: flight },
			{ label: 'Departure', value: airport(departure) },
			{ label: 'Destination', value: airport(destination) },
			...timestampFields(timestamp),
			{ label: 'Configuration header (raw)', value: configuration },
			{ label: 'Report header (raw)', value: reportHeader },
		],
		notes: [
			'The aircraft report header is recognized; report type, numeric measurements and units are not decoded.',
			'The year is inferred from reception. Continued blocks are displayed separately.',
		],
	};
}

function interpretCompactAirbus(text: string): AcarsInterpretation | undefined {
	// Semicolon-delimited Airbus reports carry H01/H02/H03 sections, unlike slash-delimited CC headers.
	const header = /^(A\d{3})([^;]*);REP(\d+),([^;]*)(?:;|$)/.exec(text);
	if (!header || !/^(?:,?\d+),\d+,\d+,TB\d+$/.test(header[2])) return;
	const [, type, configuration, report, reportHeader] = header;
	const sections = new Map([...text.matchAll(/(?:^|;)H(\d{2})([^;]*)/g)].map((match) => [match[1], match[2]]));
	const route = /^([A-Z]{4}) ([A-Z]{4})([A-Z0-9]+) +/.exec(sections.get('02') ?? '');
	const registration = /\.([A-Z0-9]+-[A-Z0-9]+?)(\d{17})$/.exec(sections.get('01') ?? '');
	const event = sections.get('03')?.trim();
	const readableEvent = event && /^[A-Za-z][A-Za-z0-9 ,()./'-]*$/.test(event) ? event : undefined;
	const airport = (code: string) => ({ NZAA: 'NZAA · Auckland Airport', OMDB: 'OMDB · Dubai International Airport' })[code] ?? code;
	const fields: AcarsField[] = [
		{ label: 'Aircraft type', value: type },
		{ label: 'Report ID', value: report },
		...(registration ? [{ label: 'Reported registration', value: registration[1] }] : []),
		...(route
			? [
					{ label: 'Reported flight code', value: route[3] },
					{ label: 'Departure', value: airport(route[1]) },
					{ label: 'Destination', value: airport(route[2]) },
				]
			: []),
		...(readableEvent ? [{ label: 'Reported event', value: readableEvent }] : []),
		{ label: 'Configuration header (raw)', value: configuration },
		{ label: 'Report header (raw)', value: reportHeader },
		...(sections.has('01') ? [{ label: 'H01 header (raw)', value: sections.get('01')! }] : []),
	];
	return {
		title: `${type} aircraft report ${report}`,
		summary: [
			type,
			registration?.[1],
			route ? `${airport(route[1])} → ${airport(route[2])}` : undefined,
			readableEvent ?? `Report ${report}`,
		]
			.filter(Boolean)
			.join(' · '),
		coverage: 'partial',
		coverageDetail: 'Header / event text decoded · measurements undecoded',
		fields,
		notes: [
			'The event text is transmitted by the aircraft. Report IDs and numbered measurement sections are not mapped to equipment parameters or units.',
			'The compact H01 date/time layout is unverified and remains raw. This report is not decoded by the Airframes library.',
		],
	};
}
