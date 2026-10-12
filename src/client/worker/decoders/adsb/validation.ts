import { isRecord } from '@/platform/data';
import type { AdsbMessage } from './types';

export function validAdsbMessage(value: unknown): value is AdsbMessage {
	if (
		!isRecord(value) ||
		value.type !== 'adsb' ||
		typeof value.freq !== 'number' ||
		!Number.isFinite(value.freq) ||
		!isRecord(value.status)
	)
		return false;
	const status = value.status;
	return (
		['off', 'receiving', 'error'].includes(String(status.state)) &&
		typeof status.message === 'string' &&
		['samples', 'frames'].every((key) => typeof status[key] === 'number' && Number.isFinite(status[key]) && status[key] >= 0) &&
		Array.isArray(value.aircraft) &&
		value.aircraft.length <= 500 &&
		value.aircraft.every(validAircraft)
	);
}

function validAircraft(value: unknown): boolean {
	if (!isRecord(value) || typeof value.icao !== 'string' || !/^[0-9A-F]{6}$/.test(value.icao)) return false;
	if (
		typeof value.lastSeen !== 'number' ||
		!Number.isFinite(value.lastSeen) ||
		typeof value.messages !== 'number' ||
		!Number.isFinite(value.messages)
	)
		return false;
	if (!validIdentifiers(value)) return false;
	if (!validCategory(value.category)) return false;
	if (value.altitudeSource !== undefined && value.altitudeSource !== 'barometric' && value.altitudeSource !== 'GNSS') return false;
	if (
		!['altitude', 'speed', 'heading', 'verticalRate', 'latitude', 'longitude', 'positionTime'].every(
			(key) => value[key] === undefined || (typeof value[key] === 'number' && Number.isFinite(value[key])),
		)
	)
		return false;
	return (
		(value.latitude === undefined || (typeof value.latitude === 'number' && Math.abs(value.latitude) <= 90)) &&
		(value.longitude === undefined || (typeof value.longitude === 'number' && Math.abs(value.longitude) <= 180))
	);
}

function validCategory(value: unknown): boolean {
	return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31);
}

function validIdentifiers(value: Record<string, unknown>): boolean {
	return (
		(value.callsign === undefined || (typeof value.callsign === 'string' && value.callsign.length <= 8)) &&
		(value.squawk === undefined || (typeof value.squawk === 'string' && /^[0-7]{4}$/.test(value.squawk)))
	);
}
