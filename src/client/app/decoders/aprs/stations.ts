import {
	APRS_STATION_LIMIT,
	APRS_STATION_TTL,
	APRS_TRAIL_LIMIT,
	type AprsPacket,
	type AprsStation,
	type AprsTelemetryDefinition,
	type AprsTrailPoint,
	type AprsWeather,
} from '@/worker/decoders/aprs/types';
import { symbolInfo } from './symbols';
import type { AprsTimedGroups } from './types';

export const stationKey = (station: Pick<AprsStation, 'type' | 'id'>) => `${station.type}:${station.id}`;

export function hasLiveStationPosition(station: AprsStation, now: number): boolean {
	return (
		!station.killed &&
		station.latitude !== undefined &&
		station.longitude !== undefined &&
		station.positionTime !== undefined &&
		now - station.positionTime <= APRS_STATION_TTL
	);
}

// Fields a report sets together, kept from whichever VFO heard that kind of report last.
const STATION_GROUPS: AprsTimedGroups<AprsStation> = [
	['positionTime', ['latitude', 'longitude', 'ambiguity', 'course', 'speed', 'altitude']],
	['statusTime', ['status']],
	['weatherTime', ['weather']],
	['telemetryTime', ['telemetry']],
];
// Separate PARM, UNIT, EQNS and BITS messages each define one part of a station's telemetry.
const DEFINITION_GROUPS: AprsTimedGroups<AprsTelemetryDefinition> = [
	['namesTime', ['names']],
	['unitsTime', ['units']],
	['equationsTime', ['equations']],
	['bitsTime', ['bits', 'project']],
];

/** Each group of fields, with its timestamp, from whichever record updated that group last. */
function newerGroups<T extends object>(groups: AprsTimedGroups<T>, first: T, second: T): Partial<T> {
	const time = (record: T, key: keyof T) => {
		const value = record[key];
		return typeof value === 'number' ? value : -Infinity;
	};
	return Object.fromEntries(
		groups.flatMap(([key, fields]) => {
			const source = time(second, key) >= time(first, key) ? second : first;
			return [key, ...fields].map((field) => [field, source[field]]);
		}),
	) as Partial<T>;
}

function mergeDefinitions(first?: AprsTelemetryDefinition, second?: AprsTelemetryDefinition): AprsTelemetryDefinition | undefined {
	return first && second ? newerGroups(DEFINITION_GROUPS, first, second) : (first ?? second);
}

function mergeTrails(first: AprsTrailPoint[], second: AprsTrailPoint[]): AprsTrailPoint[] {
	const points = [...first, ...second].sort((a, b) => a.time - b.time);
	return points
		.filter((point, index) => !index || point.latitude !== points[index - 1].latitude || point.longitude !== points[index - 1].longitude)
		.slice(-APRS_TRAIL_LIMIT);
}

function mergeStation(old: AprsStation, station: AprsStation): AprsStation {
	const [latest, earlier] = station.lastSeen >= old.lastSeen ? [station, old] : [old, station];
	const defined = Object.fromEntries(Object.entries(latest).filter(([, value]) => value !== undefined));
	return {
		...earlier,
		...defined,
		...newerGroups(STATION_GROUPS, old, station),
		packets: old.packets + station.packets,
		trail: mergeTrails(old.trail, station.trail),
		telemetryDefinition: mergeDefinitions(old.telemetryDefinition, station.telemetryDefinition),
	};
}

/**
 * One entry per station across VFOs. Position, status, weather, telemetry and each telemetry definition part
 * come from the VFO that heard them last; other fields come from the latest report, with older reports filling
 * fields it omits.
 */
export function visibleStations(sources: AprsStation[][], now: number): AprsStation[] {
	const merged = new Map<string, AprsStation>();
	for (const station of sources.flat()) {
		if (now - station.lastSeen > APRS_STATION_TTL) continue;
		const key = stationKey(station);
		const old = merged.get(key);
		merged.set(key, old ? mergeStation(old, station) : station);
	}
	return [...merged.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, APRS_STATION_LIMIT);
}

const KIND_LABELS: Record<AprsPacket['kind'], string> = {
	position: 'Position',
	object: 'Object',
	item: 'Item',
	message: 'Message',
	status: 'Status',
	telemetry: 'Telemetry',
	weather: 'Weather',
	capabilities: 'Capabilities',
	query: 'Query',
	other: 'Other APRS',
	ax25: 'AX.25 (not APRS)',
};
export const kindLabel = (packet: AprsPacket) => KIND_LABELS[packet.kind];

const fixed = (value: number | undefined, decimals: number, unit: string) =>
	value === undefined ? undefined : `${value.toFixed(decimals)}${unit}`;

export function coordinates(latitude: number, longitude: number): string {
	return `${Math.abs(latitude).toFixed(5)}°${latitude < 0 ? 'S' : 'N'} ${Math.abs(longitude).toFixed(5)}°${longitude < 0 ? 'W' : 'E'}`;
}

export function motionText(item: { speed?: number; course?: number; altitude?: number }): string {
	return [fixed(item.speed, 0, ' km/h'), item.course === undefined ? undefined : `${item.course}°`, fixed(item.altitude, 0, ' m')]
		.filter(Boolean)
		.join(' · ');
}

export function weatherText(weather: AprsWeather | undefined): string {
	if (!weather) return '';
	const wind =
		weather.windSpeed === undefined
			? undefined
			: `wind ${weather.windSpeed.toFixed(1)} m/s${weather.windDirection === undefined ? '' : ` from ${weather.windDirection}°`}`;
	return [fixed(weather.temperature, 1, ' °C'), fixed(weather.humidity, 0, '%'), fixed(weather.pressure, 1, ' hPa'), wind]
		.filter(Boolean)
		.join(' · ');
}

function messageSummary(packet: AprsPacket): string {
	const message = packet.message!;
	if (message.kind === 'ack') return `Acknowledges message ${message.id} to ${message.addressee}`;
	if (message.kind === 'reject') return `Rejects message ${message.id} to ${message.addressee}`;
	if (message.kind === 'telemetry-definition') return `Telemetry definition for ${message.addressee}: ${message.text}`;
	const label = message.kind === 'bulletin' ? `Bulletin ${message.addressee}` : `To ${message.addressee}`;
	return `${label}: ${message.text}${message.id ? ` (#${message.id})` : ''}`;
}

/** One-line decoded description for the packet log. */
export function packetSummary(packet: AprsPacket): string {
	if (packet.message) return messageSummary(packet);
	if (packet.kind === 'status') return packet.status || '(Empty status)';
	if (packet.telemetry)
		return `Sequence ${packet.telemetry.sequence}: ${packet.telemetry.analog.join(', ')}${packet.telemetry.digital ? ` · bits ${packet.telemetry.digital}` : ''}`;
	const parts: string[] = [];
	if (packet.name) parts.push(`${packet.kind === 'object' ? 'Object' : 'Item'} ${packet.name}${packet.killed ? ' (removed)' : ''}`);
	if (packet.weather) parts.push(weatherText(packet.weather));
	else if (packet.symbol) parts.push(symbolInfo(packet.symbol).name);
	if (packet.latitude !== undefined && packet.longitude !== undefined) parts.push(coordinates(packet.latitude, packet.longitude));
	const motion = motionText(packet);
	if (motion) parts.push(motion);
	if (packet.comment) parts.push(packet.comment);
	return parts.join(' · ') || packet.info;
}

/** APRS timestamps: DDHHMMz (UTC), DDHHMM/ (sender's local time), HHMMSSh (UTC) or weather MMDDHHMM. */
export function timestampText(value: string | undefined): string {
	if (!value) return '—';
	const pair = (index: number) => value.slice(index, index + 2);
	if (value.length === 8) return `${pair(0)}-${pair(2)} ${pair(4)}:${pair(6)}`;
	if (value.endsWith('h')) return `${pair(0)}:${pair(2)}:${pair(4)} UTC`;
	return `Day ${pair(0)}, ${pair(2)}:${pair(4)} ${value.endsWith('z') ? 'UTC' : 'sender local time'}`;
}
