import type { AcarsRecord } from '@/worker/decoders/acars/types';
import type { AcarsField, AcarsInterpretation } from './types';
import { messageTime } from './time';
import { labelDescription } from './catalogue';

// Fixed-width Q-label layouts documented by acarsdec. Blank times are allowed, invalid times are not.
const layouts: Record<string, string[]> = {
	Q1: ['Origin', 'Out time', 'Off time', 'On time', 'In time', 'Uninterpreted field', 'Destination'],
	Q2: ['Origin', 'ETA'],
	QA: ['Origin', 'Out time'],
	QB: ['Origin', 'Off time'],
	QC: ['Origin', 'On time'],
	QD: ['Origin', 'In time'],
	QE: ['Origin', 'Out time', 'Destination'],
	QF: ['Origin', 'Off time', 'Destination'],
	QG: ['Origin', 'Out time', 'In time'],
	QH: ['Origin', 'Out time'],
	QK: ['Origin', 'On time', 'Destination'],
	QL: ['Destination', 'Uninterpreted field', 'In time', 'Uninterpreted field', 'Origin'],
	QM: ['Destination', 'Uninterpreted field', 'Origin'],
	QN: ['Uninterpreted field', 'Destination', 'ETA'],
	QP: ['Origin', 'Destination', 'Out time'],
	QQ: ['Origin', 'Destination', 'Off time'],
	QR: ['Origin', 'Destination', 'On time'],
	QS: ['Origin', 'Destination', 'In time'],
	QT: ['Origin', 'Destination', 'Out time', 'In time'],
};

function eventField(label: string, value: string, receivedAt: number): AcarsField | undefined {
	if (!value.trim()) return { label, value: 'Not reported' };
	if (label === 'Origin' || label === 'Destination') return /^[A-Z]{3,4}$/.test(value) ? { label, value } : undefined;
	if (label === 'Uninterpreted field') return { label, value };
	if (messageTime(value, receivedAt, 'HHMM') === undefined) return;
	return { label, value: `${value.slice(0, 2)}:${value.slice(2)} UTC (date not supplied)` };
}

export function interpretEvent(message: AcarsRecord): AcarsInterpretation | undefined {
	if (message.direction !== 'downlink') return;
	const layout = layouts[message.label];
	if (!layout) return;
	const text = message.text;
	// QF also has an observed three-letter IATA airport layout.
	const widths =
		message.label === 'QF' && /^[A-Z]{3}\d{4}[A-Z]{3}$/.test(text)
			? [3, 4, 3]
			: layout.map((_, index) => (message.label === 'QL' && index === 3 ? 1 : 4));
	if (text.length < widths.reduce((sum, width) => sum + width, 0)) return;
	let offset = 0;
	const fields = layout.map((label, index) => {
		const value = text.slice(offset, offset + widths[index]);
		offset += widths[index];
		return eventField(label, value, message.receivedAt);
	});
	if (fields.some((field) => field === undefined)) return;
	const remainder = text.slice(offset).trim();
	const values = fields.filter((field): field is AcarsField => field !== undefined);
	const title = labelDescription(message.label)!.title;
	return {
		title,
		summary: `${title} · ${values.map((field) => `${field.label}: ${field.value}`).join(' · ')}`,
		coverage: remainder || values.some((field) => field.label === 'Uninterpreted field') ? 'partial' : 'decoded',
		fields: [...values, ...(remainder ? [{ label: 'Additional data (raw)', value: remainder }] : [])],
		notes: ['Out = gate departure; off = takeoff; on = landing; in = gate arrival. Time-only fields have no reported date.'],
	};
}
