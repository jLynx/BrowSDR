import { isRecord } from '@/platform/data';
import type { BleMessage } from './types';

export function validBleMessage(value: unknown): value is BleMessage {
	if (!isRecord(value) || value.type !== 'ble' || typeof value.freq !== 'number' || !Number.isFinite(value.freq) || !isRecord(value.status))
		return false;
	const status = value.status;
	return (
		['off', 'receiving', 'error'].includes(String(status.state)) &&
		typeof status.message === 'string' &&
		['samples', 'frames'].every((key) => typeof status[key] === 'number' && Number.isFinite(status[key]) && status[key] >= 0) &&
		Array.isArray(value.advertisements) &&
		value.advertisements.length <= 256 &&
		value.advertisements.every(validAdvertisement)
	);
}

function validAdvertisement(value: unknown): boolean {
	if (!isRecord(value) || typeof value.address !== 'string' || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(value.address)) return false;
	return (
		['public', 'random'].includes(String(value.addressType)) &&
		typeof value.channel === 'number' &&
		[37, 38, 39].includes(value.channel) &&
		['ADV_IND', 'ADV_DIRECT_IND', 'ADV_NONCONN_IND', 'SCAN_RSP', 'ADV_SCAN_IND'].includes(String(value.pduType)) &&
		typeof value.signalDbfs === 'number' &&
		Number.isFinite(value.signalDbfs) &&
		typeof value.data === 'string' &&
		/^[0-9A-F]{0,62}$/.test(value.data) &&
		validOptionalFields(value) &&
		validServices(value)
	);
}

function validOptionalFields(value: Record<string, unknown>): boolean {
	return (
		(value.name === undefined || (typeof value.name === 'string' && value.name.length <= 31)) &&
		(value.completeName === undefined || typeof value.completeName === 'boolean') &&
		(value.manufacturer === undefined || validInteger(value.manufacturer, 0, 65535)) &&
		(value.manufacturerData === undefined ||
			(typeof value.manufacturerData === 'string' && /^[0-9A-F]{0,58}$/.test(value.manufacturerData))) &&
		(value.txPower === undefined || validInteger(value.txPower, -128, 127))
	);
}

function validInteger(value: unknown, min: number, max: number): boolean {
	return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function validServices(value: Record<string, unknown>): boolean {
	return (
		Array.isArray(value.services) &&
		value.services.length <= 31 &&
		value.services.every((uuid: unknown) => typeof uuid === 'string' && /^(?:[0-9A-F]{4}|[0-9A-F]{8}|[0-9A-F]{32})$/.test(uuid)) &&
		Array.isArray(value.serviceData) &&
		value.serviceData.length <= 15 &&
		value.serviceData.every((data: unknown) => typeof data === 'string' && data.length <= 100)
	);
}
