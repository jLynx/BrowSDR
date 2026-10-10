import type { AcarsField } from './types';

/** These payloads omit dates; choose the valid UTC date closest to reception. */
export function messageTime(value: string, receivedAt: number, format: 'HHMM' | 'HHMMSS' | 'DDHHMM'): number | undefined {
	if (format === 'HHMM') return /^\d{4}$/.test(value) ? messageTime(`${value}00`, receivedAt, 'HHMMSS') : undefined;
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

export function timeFields(value: string, receivedAt: number, format: 'HHMM' | 'HHMMSS' | 'DDHHMM'): AcarsField[] {
	const timestamp = messageTime(value, receivedAt, format);
	if (timestamp === undefined) return [];
	return timestampFields(timestamp, format === 'HHMM');
}

export function timestampFields(timestamp: number, minutePrecision = false): AcarsField[] {
	const date = new Date(timestamp);
	return [
		{
			label: 'Event time (UTC)',
			value: `${date
				.toISOString()
				.replace('T', ' ')
				.slice(0, minutePrecision ? 16 : 19)} UTC`,
		},
		{
			label: 'Event time (local)',
			value: new Intl.DateTimeFormat(
				undefined,
				minutePrecision
					? { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }
					: { dateStyle: 'medium', timeStyle: 'long' },
			).format(date),
		},
	];
}

const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Returns an exact UTC date; never allows Date to roll invalid days into another month. */
export function datedTime(dateCode: string, clock: string): number | undefined {
	const match = /^(\d{2})([A-Z]{3})(\d{2})$/.exec(dateCode);
	if (!match || !/^\d{4}(?:\d{2})?$/.test(clock)) return;
	const [, dayCode, monthCode, yearCode] = match;
	const month = months.indexOf(monthCode);
	const day = Number(dayCode);
	const hour = Number(clock.slice(0, 2));
	const minute = Number(clock.slice(2, 4));
	const second = Number(clock.slice(4) || 0);
	if (month < 0 || day < 1 || hour > 23 || minute > 59 || second > 59) return;
	const date = new Date(Date.UTC(2000 + Number(yearCode), month, day, hour, minute, second));
	return date.getUTCMonth() === month && date.getUTCDate() === day ? date.getTime() : undefined;
}

export function monthDayTime(dateCode: string, clock: string, receivedAt: number): number | undefined {
	const match = /^([A-Z]{3})(\d{2})$/.exec(dateCode);
	const year = new Date(receivedAt).getUTCFullYear();
	if (!match || !Number.isFinite(year) || year < 2001 || year > 2098) return;
	return [-1, 0, 1]
		.map((offset) => datedTime(`${match[2]}${match[1]}${String(year + offset).slice(-2)}`, clock))
		.filter((timestamp): timestamp is number => timestamp !== undefined)
		.sort((a, b) => Math.abs(a - receivedAt) - Math.abs(b - receivedAt))[0];
}
