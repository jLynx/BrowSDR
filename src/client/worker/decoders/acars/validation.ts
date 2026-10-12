import { isRecord } from '@/platform/data';
import type { AcarsMessage } from './types';

export function validAcarsMessage(value: unknown): value is AcarsMessage {
	if (!isRecord(value) || value.type !== 'acars' || !finite(value.freq) || !isRecord(value.status)) return false;
	const status = value.status;
	return (
		['off', 'receiving', 'error'].includes(String(status.state)) &&
		typeof status.message === 'string' &&
		status.message.length <= 500 &&
		finite(status.samples) &&
		status.samples >= 0 &&
		finite(status.frames) &&
		status.frames >= 0 &&
		Array.isArray(value.messages) &&
		value.messages.length <= 200 &&
		value.messages.every(validRecord)
	);
}

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function validRecord(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		finite(value.id) &&
		Number.isSafeInteger(value.id) &&
		value.id > 0 &&
		finite(value.receivedAt) &&
		value.receivedAt >= 0 &&
		typeof value.registration === 'string' &&
		/^[\x20-\x7e]{1,7}$/.test(value.registration) &&
		['mode', 'acknowledgement', 'label', 'blockId', 'text'].every((key) => typeof value[key] === 'string' && value[key].length <= 240) &&
		['flight', 'messageNumber'].every((key) => value[key] === undefined || (typeof value[key] === 'string' && value[key].length <= 10)) &&
		['downlink', 'uplink'].includes(String(value.direction)) &&
		typeof value.continuation === 'boolean'
	);
}
