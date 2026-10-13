import { isRecord } from '@/platform/data';
import { SONDE_LIMIT, SONDE_TRAIL_LIMIT, type RadiosondeMessage } from './types';

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
export function validRadiosondeMessage(value: unknown): value is RadiosondeMessage {
	if (!isRecord(value) || value.type !== 'radiosonde' || !finite(value.freq) || !isRecord(value.status)) return false;
	const status = value.status;
	return (
		['off', 'receiving', 'error'].includes(String(status.state)) &&
		typeof status.message === 'string' &&
		status.message.length <= 500 &&
		['samples', 'frames', 'syncs', 'crcErrors'].every((key) => finite(status[key]) && Number(status[key]) >= 0) &&
		Array.isArray(value.sondes) &&
		value.sondes.length <= SONDE_LIMIT &&
		value.sondes.every(validSonde)
	);
}

function validSonde(value: unknown): boolean {
	if (!isRecord(value) || typeof value.id !== 'string' || !/^[A-Z0-9]{8}$/.test(value.id) || value.model !== 'RS41') return false;
	if (!['frame', 'lastSeen', 'messages', 'frequency'].every((key) => finite(value[key]) && Number(value[key]) >= 0)) return false;
	if (
		![
			'battery',
			'latitude',
			'longitude',
			'altitude',
			'positionTime',
			'speed',
			'course',
			'climb',
			'satellites',
			'gpsTime',
			'maxAltitude',
			'temperature',
			'humiditySensorTemperature',
			'humidity',
			'pressure',
			'estimatedPressure',
			'pressureSensorTemperature',
			'dewPoint',
			'weatherTime',
			'firmware',
			'txFrequency',
			'txPower',
			'referenceTemperature',
			'burstTimer',
			'flightTimer',
			'killCountdown',
			'killCountdownTime',
			'statusFlags',
			'errorFlags',
			'cryptoMode',
			'humidityHeating',
			'positionDop',
			'speedAccuracy',
			'calibrationCount',
			'calibrationTotal',
			'gnssJamming',
			'gnssAgc',
		].every((key) => value[key] === undefined || finite(value[key]))
	)
		return false;
	if (!validExtraFields(value)) return false;
	if (
		(value.latitude !== undefined && Math.abs(Number(value.latitude)) > 90) ||
		(value.longitude !== undefined && Math.abs(Number(value.longitude)) > 180)
	)
		return false;
	return (
		Array.isArray(value.trail) &&
		value.trail.length <= SONDE_TRAIL_LIMIT &&
		value.trail.every(
			(point) =>
				isRecord(point) &&
				['latitude', 'longitude', 'altitude', 'time'].every((key) => finite(point[key])) &&
				Math.abs(Number(point.latitude)) <= 90 &&
				Math.abs(Number(point.longitude)) <= 180,
		)
	);
}

function validExtraFields(value: Record<string, unknown>): boolean {
	if (
		!['subtype', 'mainboard', 'mainboardSerial', 'pressureSensorSerial'].every(
			(key) => value[key] === undefined || (typeof value[key] === 'string' && value[key].length <= 32),
		)
	)
		return false;
	if (!['burstKill', 'calibrationComplete'].every((key) => value[key] === undefined || typeof value[key] === 'boolean')) return false;
	if (
		value.flightPhase !== undefined &&
		(typeof value.flightPhase !== 'string' || !['startup', 'ascent', 'descent'].includes(value.flightPhase))
	)
		return false;
	if (
		value.configuration !== undefined &&
		(!Array.isArray(value.configuration) ||
			value.configuration.length > 80 ||
			!value.configuration.every(
				(field) =>
					isRecord(field) &&
					typeof field.label === 'string' &&
					field.label.length <= 100 &&
					(finite(field.value) || (typeof field.value === 'string' && field.value.length <= 200)) &&
					(field.unit === undefined || (typeof field.unit === 'string' && field.unit.length <= 30)),
			))
	)
		return false;
	if (
		value.rawBlocks !== undefined &&
		(!Array.isArray(value.rawBlocks) ||
			value.rawBlocks.length > 32 ||
			!value.rawBlocks.every(
				(block) =>
					isRecord(block) &&
					Number.isInteger(block.type) &&
					Number(block.type) >= 0 &&
					Number(block.type) <= 255 &&
					typeof block.crcValid === 'boolean' &&
					typeof block.data === 'string' &&
					block.data.length <= 510 &&
					/^(?:[a-f0-9]{2})*$/.test(block.data),
			))
	)
		return false;
	if (
		value.calibrationFragments !== undefined &&
		(!Array.isArray(value.calibrationFragments) ||
			value.calibrationFragments.length > 51 ||
			!value.calibrationFragments.every(
				(fragment) =>
					isRecord(fragment) &&
					Number.isInteger(fragment.index) &&
					Number(fragment.index) >= 0 &&
					Number(fragment.index) <= 50 &&
					typeof fragment.data === 'string' &&
					/^[a-f0-9]{32}$/.test(fragment.data),
			))
	)
		return false;
	return validMeasurements(value.measurements) && validGnss(value.gnssSatellites) && validAuxiliary(value.auxiliary);
}

function validMeasurements(value: unknown): boolean {
	return value === undefined || (Array.isArray(value) && value.length <= 12 && value.every(finite));
}

function validGnss(value: unknown): boolean {
	return (
		value === undefined ||
		(Array.isArray(value) &&
			value.length <= 12 &&
			value.every(
				(sat) =>
					isRecord(sat) &&
					['prn', 'signal', 'quality'].every((key) => finite(sat[key])) &&
					['pseudorange', 'doppler'].every((key) => sat[key] === undefined || finite(sat[key])),
			))
	);
}

function validAuxiliary(value: unknown): boolean {
	return (
		value === undefined ||
		(Array.isArray(value) && value.length <= 32 && value.every((text) => typeof text === 'string' && text.length <= 510))
	);
}
