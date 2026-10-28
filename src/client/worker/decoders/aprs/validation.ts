import { isRecord } from '@/platform/data';
import { APRS_PACKET_LIMIT, APRS_STATION_LIMIT, APRS_TRAIL_LIMIT, type AprsMessage } from './types';

const KINDS = ['position', 'object', 'item', 'message', 'status', 'telemetry', 'weather', 'capabilities', 'query', 'other', 'ax25'];
const FORMATS = ['uncompressed', 'compressed', 'mic-e', 'nmea'];
const MESSAGE_KINDS = ['message', 'ack', 'reject', 'bulletin', 'telemetry-definition'];
const REPORT_NUMBERS = ['latitude', 'longitude', 'ambiguity', 'course', 'speed', 'altitude', 'range'];
const STATION_TIMES = ['positionTime', 'statusTime', 'weatherTime', 'telemetryTime'];

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown, length: number) => typeof value === 'string' && value.length <= length;
const optionalText = (value: unknown, length: number) => value === undefined || text(value, length);
const callsign = (value: unknown) => typeof value === 'string' && /^[A-Z0-9]{1,6}(-[0-9A-Z]{1,2})?$/.test(value);
const numbers = (value: Record<string, unknown>, keys: string[]) => keys.every((key) => value[key] === undefined || finite(value[key]));
const strings = (value: unknown, count: number, length: number) =>
	Array.isArray(value) && value.length <= count && value.every((item) => text(item, length));

export function validAprsMessage(value: unknown): value is AprsMessage {
	if (!isRecord(value) || value.type !== 'aprs' || !finite(value.freq) || !isRecord(value.status)) return false;
	const status = value.status;
	return (
		['off', 'receiving', 'error'].includes(String(status.state)) &&
		text(status.message, 500) &&
		['samples', 'frames'].every((key) => finite(status[key]) && Number(status[key]) >= 0) &&
		Array.isArray(value.stations) &&
		value.stations.length <= APRS_STATION_LIMIT &&
		value.stations.every(validStation) &&
		Array.isArray(value.packets) &&
		value.packets.length <= APRS_PACKET_LIMIT &&
		value.packets.every(validPacket)
	);
}

function validPosition(value: Record<string, unknown>): boolean {
	return (
		numbers(value, REPORT_NUMBERS) &&
		(value.latitude === undefined || Math.abs(Number(value.latitude)) <= 90) &&
		(value.longitude === undefined || Math.abs(Number(value.longitude)) <= 180)
	);
}

function validReportFields(value: Record<string, unknown>): boolean {
	return (
		validPosition(value) &&
		optionalText(value.symbol, 2) &&
		['comment', 'status'].every((key) => optionalText(value[key], 512)) &&
		['timestamp', 'micEStatus'].every((key) => optionalText(value[key], 20)) &&
		['messaging', 'killed'].every((key) => value[key] === undefined || typeof value[key] === 'boolean') &&
		(value.phg === undefined || validPhg(value.phg)) &&
		(value.weather === undefined ||
			(isRecord(value.weather) && Object.values(value.weather).every((item) => item === undefined || finite(item)))) &&
		(value.telemetry === undefined || validTelemetry(value.telemetry))
	);
}

function validPhg(value: unknown): boolean {
	return isRecord(value) && ['power', 'height', 'gain', 'directivity'].every((key) => finite(value[key]));
}

function validTelemetry(value: unknown): boolean {
	return (
		isRecord(value) &&
		text(value.sequence, 5) &&
		Array.isArray(value.analog) &&
		value.analog.length <= 5 &&
		value.analog.every(finite) &&
		(value.digital === undefined || (typeof value.digital === 'string' && /^[01]{1,8}$/.test(value.digital)))
	);
}

function validDefinition(value: unknown): boolean {
	return (
		isRecord(value) &&
		(value.names === undefined || strings(value.names, 13, 64)) &&
		(value.units === undefined || strings(value.units, 13, 64)) &&
		(value.equations === undefined ||
			(Array.isArray(value.equations) &&
				value.equations.length <= 5 &&
				value.equations.every((item) => Array.isArray(item) && item.length === 3 && item.every(finite)))) &&
		(value.bits === undefined || (typeof value.bits === 'string' && /^[01]{8}$/.test(value.bits))) &&
		optionalText(value.project, 256)
	);
}

function validStation(value: unknown): boolean {
	if (!isRecord(value) || !['station', 'object', 'item'].includes(String(value.type))) return false;
	if (value.type === 'station' ? !callsign(value.id) : !(typeof value.id === 'string' && /^[ -~]{1,9}$/.test(value.id))) return false;
	if (!finite(value.lastSeen) || !finite(value.packets) || value.packets < 0 || !numbers(value, STATION_TIMES)) return false;
	return (
		(value.owner === undefined || callsign(value.owner)) &&
		optionalText(value.destination, 9) &&
		optionalText(value.path, 100) &&
		validReportFields(value) &&
		(value.telemetryDefinition === undefined || validDefinition(value.telemetryDefinition)) &&
		Array.isArray(value.trail) &&
		value.trail.length <= APRS_TRAIL_LIMIT &&
		value.trail.every(
			(point) => isRecord(point) && finite(point.time) && validPosition(point) && finite(point.latitude) && finite(point.longitude),
		)
	);
}

function validPacketHeader(value: Record<string, unknown>): boolean {
	return (
		finite(value.id) &&
		Number.isSafeInteger(value.id) &&
		value.id > 0 &&
		finite(value.receivedAt) &&
		callsign(value.source) &&
		callsign(value.destination) &&
		strings(value.path, 8, 10) &&
		text(value.info, 2000) &&
		typeof value.kind === 'string' &&
		KINDS.includes(value.kind) &&
		(value.format === undefined || (typeof value.format === 'string' && FORMATS.includes(value.format)))
	);
}

function validPacket(value: unknown): boolean {
	if (!isRecord(value) || !validPacketHeader(value)) return false;
	return (
		(value.relay === undefined || callsign(value.relay)) &&
		(value.duplicate === undefined || typeof value.duplicate === 'boolean') &&
		(value.name === undefined || (typeof value.name === 'string' && /^[ -~]{1,9}$/.test(value.name))) &&
		(value.message === undefined || validTextMessage(value.message)) &&
		validReportFields(value)
	);
}

function validTextMessage(value: unknown): boolean {
	return (
		isRecord(value) &&
		MESSAGE_KINDS.includes(String(value.kind)) &&
		text(value.addressee, 9) &&
		text(value.text, 512) &&
		(value.id === undefined || (typeof value.id === 'string' && /^[A-Za-z0-9]{1,5}$/.test(value.id)))
	);
}
