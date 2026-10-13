import type { Radiosonde, SondeField } from '@/worker/decoders/radiosonde/types';
import { hasLiveSondePosition } from './sondes';

const number = (value: number | undefined, decimals = 1, unit = '') => (value === undefined ? '—' : `${value.toFixed(decimals)}${unit}`);
const hex = (value: number | undefined) => (value === undefined ? '—' : `0x${value.toString(16).padStart(4, '0')}`);
const timer = (value: number | undefined) =>
	value === undefined ? '—' : value < 0 ? 'Inactive' : `${Math.floor(value / 60)}m ${value % 60}s`;

function countdown(sonde: Radiosonde, now: number): number | undefined {
	if (sonde.killCountdown === undefined) return undefined;
	if (sonde.killCountdown < 0) return -1;
	return Math.max(0, sonde.killCountdown - Math.floor((now - (sonde.killCountdownTime ?? now)) / 1000));
}

export function sondeDetails(sonde: Radiosonde | undefined, now: number): SondeField[] {
	if (!sonde) return [];
	const weatherAge = sonde.weatherTime === undefined ? undefined : Math.max(0, Math.floor((now - sonde.weatherTime) / 1000));
	const remaining = countdown(sonde, now);
	const fields: Array<[string, string]> = [
		['Sonde ID', sonde.id],
		['Sonde type', sonde.subtype ?? sonde.model],
		['Receive frequency', number(sonde.frequency, 3, ' MHz')],
		['TX frequency', number(sonde.txFrequency, 3, ' MHz')],
		['Position', hasLiveSondePosition(sonde, now) ? `${number(sonde.latitude, 5)}, ${number(sonde.longitude, 5)}` : 'No current GPS fix'],
		['GPS altitude', number(sonde.altitude, 0, ' m')],
		['Maximum received altitude', number(sonde.maxAltitude, 0, ' m')],
		['Ground speed', number(sonde.speed, 1, ' m/s')],
		['Climb / descent', number(sonde.climb, 1, ' m/s')],
		['Course', number(sonde.course, 0, '°')],
		['Flight phase', sonde.flightPhase ?? '—'],
		['GNSS satellites used', number(sonde.satellites, 0)],
		['Position dilution (PDOP)', number(sonde.positionDop)],
		['Speed accuracy', number(sonde.speedAccuracy, 1, ' m/s')],
		['GNSS jamming indicator', number(sonde.gnssJamming, 0)],
		['GNSS AGC code', number(sonde.gnssAgc, 0)],
		['Temperature, external', number(sonde.temperature, 1, ' °C')],
		['Relative humidity', number(sonde.humidity, 1, '%')],
		['Humidity sensor temperature', number(sonde.humiditySensorTemperature, 1, ' °C')],
		['Dew point', number(sonde.dewPoint, 1, ' °C')],
		['Pressure, sensor', number(sonde.pressure, 2, ' hPa')],
		['Pressure, standard atmosphere estimate', number(sonde.estimatedPressure, 2, ' hPa')],
		['Pressure sensor temperature', number(sonde.pressureSensorTemperature, 1, ' °C')],
		[
			'Weather age',
			weatherAge === undefined ? 'Waiting for calibration / sensor data' : `${weatherAge}s${weatherAge > 30 ? ' · stale' : ''}`,
		],
		['Battery voltage', number(sonde.battery, 1, ' V')],
		['Burst kill', sonde.burstKill === undefined ? '—' : sonde.burstKill ? 'Enabled' : 'Disabled'],
		['Kill countdown', timer(remaining)],
		['Configured burst timer', timer(sonde.burstTimer)],
		['Configured flight timer', timer(sonde.flightTimer)],
		['RS41 PCB version', sonde.mainboard ?? '—'],
		['Mainboard serial', sonde.mainboardSerial ?? '—'],
		['Pressure sensor serial', sonde.pressureSensorSerial ?? '—'],
		['Firmware version', number(sonde.firmware, 0)],
		['TX power level', number(sonde.txPower, 0)],
		['Reference / PCB temperature', number(sonde.referenceTemperature, 0, ' °C')],
		['Humidity heater PWM', number(sonde.humidityHeating, 1, '%')],
		['Status flags', hex(sonde.statusFlags)],
		['Error flags', hex(sonde.errorFlags)],
		['Crypto mode', number(sonde.cryptoMode, 0)],
		[
			'Calibration fragments',
			`${sonde.calibrationCount ?? 0} / ${sonde.calibrationTotal ?? 51}${sonde.calibrationComplete ? ' · full CRC valid' : ''}`,
		],
		['Frame / received', `${sonde.frame} / ${sonde.messages}`],
		['Datetime (local)', sonde.gpsTime === undefined ? '—' : new Date(sonde.gpsTime).toLocaleString()],
		['GPS time (UTC)', sonde.gpsTime === undefined ? '—' : new Date(sonde.gpsTime).toISOString()],
		['Last received', `${Math.max(0, Math.floor((now - sonde.lastSeen) / 1000))}s ago`],
	];
	return fields.map(([label, value]) => ({ label, value }));
}
