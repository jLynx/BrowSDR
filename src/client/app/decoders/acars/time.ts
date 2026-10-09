import type { AcarsField } from './types';

/** These payloads omit dates; choose the valid UTC date closest to reception. */
export function messageTime(value: string, receivedAt: number, format: 'HHMMSS' | 'DDHHMM'): number | undefined {
	if (!/^\d{6}$/.test(value) || !Number.isFinite(receivedAt)) return;
	const day = format === 'DDHHMM' ? Number(value.slice(0, 2)) : undefined;
	const hour = Number(value.slice(day === undefined ? 0 : 2, day === undefined ? 2 : 4));
	const minute = Number(value.slice(day === undefined ? 2 : 4, day === undefined ? 4 : 6));
	const second = day === undefined ? Number(value.slice(4, 6)) : 0;
	if (hour > 23 || minute > 59 || second > 59 || (day !== undefined && (day < 1 || day > 31))) return;
	const received = new Date(receivedAt);
	if (!Number.isFinite(received.getTime())) return;
	const candidates = [-1, 0, 1].map((offset) => {
		const date = new Date(Date.UTC(received.getUTCFullYear(), received.getUTCMonth() + (day === undefined ? 0 : offset), 1));
		date.setUTCDate(day ?? received.getUTCDate() + offset);
		date.setUTCHours(hour, minute, second, 0);
		return day === undefined || date.getUTCDate() === day ? date.getTime() : NaN;
	});
	return candidates.filter(Number.isFinite).sort((a, b) => Math.abs(a - receivedAt) - Math.abs(b - receivedAt))[0];
}

export function timeFields(value: string, receivedAt: number, format: 'HHMMSS' | 'DDHHMM'): AcarsField[] {
	const timestamp = messageTime(value, receivedAt, format);
	if (timestamp === undefined) return [];
	const date = new Date(timestamp);
	return [
		{ label: 'Event time (UTC)', value: `${date.toISOString().replace('T', ' ').slice(0, 19)} UTC` },
		{
			label: 'Event time (local)',
			value: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(date),
		},
	];
}
