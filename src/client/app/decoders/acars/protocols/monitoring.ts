import type { AcarsInterpretation } from '@/app/decoders/acars/types';

const airports: Record<string, string> = { NZAA: 'Auckland Airport', ZSPD: 'Shanghai Pudong International Airport' };
const airport = (code: string) => (airports[code] ? `${code} · ${airports[code]}` : code);

/** Identifies the transmitted ACM header; its numeric report dictionary is unavailable. */
export function interpretAcm(text: string): AcarsInterpretation | undefined {
	if (text.length > 8192) return;
	const header =
		/^(ACM\d{2})(ACM[A-Z0-9]{1,16})(B-\d{4}) +([A-Z]{3}\d{1,4}[A-Z]?) +([A-Z]{4})([A-Z]{4})(\d{6}) +(\d{2}[A-Z]{2})(\d{6})/.exec(text);
	if (!header) return;
	const [, format, configuration, registration, flight, departure, destination, date, code, clock] = header;
	return {
		title: `Aircraft monitoring report ${code}`,
		summary: `${registration} · ${flight} · ${airport(departure)} → ${airport(destination)} · monitoring report ${code}.`,
		coverage: 'partial',
		coverageDetail: 'Header identified · measurements undecoded',
		fields: [
			{ label: 'Report format', value: format },
			{ label: 'Reported registration', value: registration },
			{ label: 'Reported flight code', value: flight },
			{ label: 'Departure', value: airport(departure) },
			{ label: 'Destination', value: airport(destination) },
			{ label: 'Report code (raw)', value: code },
			{ label: 'Configuration header (raw)', value: configuration },
			{ label: 'Header date code (raw)', value: date },
			{ label: 'Header time code (raw)', value: clock },
		],
		notes: [
			'The ACM header identifies the aircraft, flight and route. The report/configuration codes and numeric measurements have no verified dictionary or units.',
			'The date and time codes are retained as transmitted; their format and timezone are unverified. This is not a decoded fault diagnosis.',
		],
	};
}
