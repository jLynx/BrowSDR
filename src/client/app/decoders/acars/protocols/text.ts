// Selected text layouts from MIT Python Skyshark and Rust datalink.
import type { AcarsRecord } from '@/worker/decoders/acars/types';
import type { AcarsField, AcarsInterpretation } from '@/app/decoders/acars/types';
import { datedTime, timestampFields } from '@/app/decoders/acars/time';

function positionFields(latitude: number, longitude: number): AcarsField[] | undefined {
	if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return;
	return [
		{ label: 'Latitude', value: `${latitude}°` },
		{ label: 'Longitude', value: `${longitude}°` },
	];
}

function decimalPosition(message: AcarsRecord): AcarsInterpretation | undefined {
	if (!['21', '22', '31', '36', '44'].includes(message.label)) return;
	const match = /^(?:POSN +)?([NS]) *(\d{1,2}\.\d+) +([EW]) *(\d{1,3}\.\d+)(?:,([^]*))?$/.exec(message.text.trim());
	if (!match) return;
	const fields = positionFields(Number(match[2]) * (match[1] === 'S' ? -1 : 1), Number(match[4]) * (match[3] === 'W' ? -1 : 1));
	if (!fields) return;
	return result(
		'Position report',
		fields,
		Boolean(match[5]),
		'datalink decimal position',
		match[5] ? ['Additional telemetry remains raw; numeric tokens are not treated as altitude without a verified layout.'] : [],
	);
}

function gaPosition(message: AcarsRecord): AcarsInterpretation | undefined {
	if (message.label !== '15') return;
	const match = /^\(2([NS])(\d{5})([EW])(\d{6})(?:OFF(\d{2})(\d{2})(\d{2})(\d{4}))?([^]*)\(Z$/.exec(message.text.trim());
	if (!match) return;
	const fields = positionFields(
		(Number(match[2]) / 1000) * (match[1] === 'S' ? -1 : 1),
		(Number(match[4]) / 1000) * (match[3] === 'W' ? -1 : 1),
	);
	if (!fields) return;
	if (match[5]) {
		const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
		const timestamp = datedTime(`${match[5]}${months[Number(match[6]) - 1] ?? ''}${match[7]}`, match[8]);
		if (timestamp === undefined) return;
		fields.push(...timestampFields(timestamp, true));
	}
	return result(
		'General aviation position report',
		fields,
		Boolean(match[9]),
		'Skyshark label 15',
		match[9] ? ['Additional payload fields remain undecoded.'] : [],
	);
}

function frequencyChange(message: AcarsRecord): AcarsInterpretation | undefined {
	if (message.label !== ':;' || !/^\d{6}$/.test(message.text.trim())) return;
	const frequency = Number(message.text.trim()) / 1000;
	if (frequency < 118 || frequency > 137) return;
	return result(
		'Frequency change',
		[{ label: 'Requested frequency', value: `${frequency.toFixed(3)} MHz` }],
		false,
		'Skyshark frequency change',
		['This is a received network instruction; it does not retune the receiver.'],
	);
}

function maintenance(message: AcarsRecord): AcarsInterpretation | undefined {
	if (message.label !== 'H1' || !/^MDC REPORT: *ENGINE TREND\r?\n/.test(message.text)) return;
	const fields: AcarsField[] = [];
	const names: Record<string, string> = {
		N1: 'N1',
		N2: 'N2',
		ITT: 'Inter-turbine temperature',
		PS3: 'Compressor discharge pressure',
		'N1 VIBES': 'N1 vibration',
		'N2 VIBES': 'N2 vibration',
		'OIL TEMP': 'Oil temperature',
		'OIL PRESS': 'Oil pressure',
		PLA: 'Power lever angle',
		'FUEL FLOW': 'Fuel flow',
		'VG POS': 'Variable geometry position',
	};
	for (const match of message.text.matchAll(/\b([LR]) +([A-Z0-9 ]+?) +(-?\d+(?:\.\d+)?) +([A-Z%]+)(?=\s|$)/g)) {
		const name = names[match[2].trim()];
		if (name) fields.push({ label: `${match[1] === 'L' ? 'Left' : 'Right'} engine ${name}`, value: `${match[3]} ${match[4]}` });
	}
	if (!fields.length) return;
	return result('Engine trend report', fields, true, 'Explicit MDC engine fields', [
		'Only named measurements and their transmitted units are extracted. Other maintenance fields remain raw.',
	]);
}

function result(title: string, fields: AcarsField[], partial: boolean, source: string, notes: string[]): AcarsInterpretation {
	return {
		title,
		summary: `${title} · ${fields
			.slice(0, 2)
			.map((field) => `${field.label}: ${field.value}`)
			.join(' · ')}`,
		coverage: partial ? 'partial' : 'decoded',
		fields: [...fields, { label: 'Payload parser', value: `BrowSDR · ${source}` }],
		notes,
	};
}

export function interpretText(message: AcarsRecord): AcarsInterpretation | undefined {
	if (message.text.length > 8192) return;
	if (message.direction === 'uplink') return frequencyChange(message);
	return gaPosition(message) ?? decimalPosition(message) ?? maintenance(message);
}
