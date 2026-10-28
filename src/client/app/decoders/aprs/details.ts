import type { AprsStation, AprsWeather } from '@/worker/decoders/aprs/types';
import type { AprsField } from './types';
import { coordinates, hasLiveStationPosition, motionText } from './stations';
import { symbolInfo } from './symbols';

const number = (value: number | undefined, decimals: number, unit = '') =>
	value === undefined ? undefined : `${value.toFixed(decimals)}${unit}`;
const age = (time: number | undefined, now: number) =>
	time === undefined ? undefined : `${Math.max(0, Math.round((now - time) / 1000))}s ago`;

function positionText(station: AprsStation, now: number): string {
	if (!hasLiveStationPosition(station, now)) return station.killed ? 'Removed by its owner' : 'No current position';
	const approximate = station.ambiguity ? ` (approximate, ${station.ambiguity} digits withheld)` : '';
	return coordinates(station.latitude!, station.longitude!) + approximate;
}

function phgText(station: AprsStation): string | undefined {
	const phg = station.phg;
	if (!phg) return;
	return `${phg.power} W · ${phg.height.toFixed(0)} m HAAT · ${phg.gain} dBi · ${phg.directivity ? `${phg.directivity}°` : 'omni'}`;
}

export function stationDetails(station: AprsStation | undefined, now: number): AprsField[] {
	if (!station) return [];
	const fields: Array<[string, string | undefined]> = [
		[station.type === 'station' ? 'Callsign' : station.type === 'object' ? 'Object' : 'Item', station.id],
		['Reported by', station.owner],
		['Symbol', symbolInfo(station.symbol).name],
		['Position', positionText(station, now)],
		['Motion', motionText(station) || undefined],
		['Mic-E status', station.micEStatus],
		['Station', phgText(station)],
		['Range', number(station.range, 0, ' km')],
		['Comment', station.comment],
		['Status', station.status === undefined ? undefined : `${station.status || '(empty)'} · ${age(station.statusTime, now)}`],
		['Messaging', station.messaging === undefined ? undefined : station.messaging ? 'Accepts messages' : 'No messaging'],
		['Last path', station.path === undefined ? undefined : station.path || 'Direct'],
		['Destination / software', station.destination],
		['Packets', String(station.packets)],
		['Last heard', age(station.lastSeen, now)],
	];
	return fields.filter((field): field is [string, string] => field[1] !== undefined).map(([label, value]) => ({ label, value }));
}

export function weatherDetails(weather: AprsWeather | undefined): AprsField[] {
	if (!weather) return [];
	const fields: Array<[string, string | undefined]> = [
		['Temperature', number(weather.temperature, 1, ' °C')],
		['Humidity', number(weather.humidity, 0, '%')],
		['Pressure', number(weather.pressure, 1, ' hPa')],
		['Wind', number(weather.windSpeed, 1, ' m/s')],
		['Wind direction', number(weather.windDirection, 0, '°')],
		['Gust', number(weather.windGust, 1, ' m/s')],
		['Rain, last hour', number(weather.rain1h, 1, ' mm')],
		['Rain, last 24 hours', number(weather.rain24h, 1, ' mm')],
		['Rain since midnight', number(weather.rainSinceMidnight, 1, ' mm')],
		['Luminosity', number(weather.luminosity, 0, ' W/m²')],
		['Snow, last 24 hours', number(weather.snow24h, 0, ' mm')],
	];
	return fields.filter((field): field is [string, string] => field[1] !== undefined).map(([label, value]) => ({ label, value }));
}

/** Analog values scaled by the station's EQNS coefficients, labelled with its PARM names and UNIT strings. */
export function telemetryDetails(station: AprsStation | undefined): AprsField[] {
	const telemetry = station?.telemetry;
	if (!telemetry) return [];
	const definition = station.telemetryDefinition ?? {};
	const fields = telemetry.analog.map((raw, index) => {
		const [a, b, c] = definition.equations?.[index] ?? [0, 1, 0];
		const value = a * raw * raw + b * raw + c;
		const unit = definition.units?.[index] ? ` ${definition.units[index]}` : '';
		return { label: definition.names?.[index] || `Analog ${index + 1}`, value: `${Number(value.toFixed(3))}${unit}` };
	});
	[...(telemetry.digital ?? '')].forEach((bit, index) => {
		const name = definition.names?.[index + 5] || `Bit ${index + 1}`;
		// BITS gives the active state of each bit; without it a one is active.
		const active = bit === (definition.bits?.[index] ?? '1');
		const unit = definition.units?.[index + 5];
		fields.push({ label: name, value: unit ? `${active ? 'On' : 'Off'} (${unit})` : active ? 'On' : 'Off' });
	});
	return [
		{ label: 'Sequence', value: telemetry.sequence },
		...(definition.project ? [{ label: 'Project', value: definition.project }] : []),
		...fields,
	];
}
