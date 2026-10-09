import { isRecord } from '@/platform/data';
import type { AisMessage } from './types';

export function validAisMessage(value: unknown): value is AisMessage {
	if (!isRecord(value) || value.type !== 'ais' || typeof value.freq !== 'number' || !Number.isFinite(value.freq) || !isRecord(value.status))
		return false;
	const status = value.status;
	return (
		['off', 'receiving', 'error'].includes(String(status.state)) &&
		typeof status.message === 'string' &&
		['samples', 'frames'].every((key) => typeof status[key] === 'number' && Number.isFinite(status[key]) && status[key] >= 0) &&
		Array.isArray(value.vessels) &&
		value.vessels.length <= 500 &&
		value.vessels.every(validVessel)
	);
}

function validVessel(value: unknown): boolean {
	if (!isRecord(value) || typeof value.mmsi !== 'string' || !/^\d{9}$/.test(value.mmsi)) return false;
	if (!['lastSeen', 'messages'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0))
		return false;
	if (
		!['name', 'callsign', 'destination'].every(
			(key) => value[key] === undefined || (typeof value[key] === 'string' && value[key].length <= 120),
		)
	)
		return false;
	if (
		!['imo', 'shipType', 'draught', 'navigationStatus', 'speed', 'course', 'heading', 'latitude', 'longitude', 'positionTime'].every(
			(key) => value[key] === undefined || (typeof value[key] === 'number' && Number.isFinite(value[key])),
		)
	)
		return false;
	return (
		(value.latitude === undefined || (typeof value.latitude === 'number' && Math.abs(value.latitude) <= 90)) &&
		(value.longitude === undefined || (typeof value.longitude === 'number' && Math.abs(value.longitude) <= 180))
	);
}
