import type { AircraftMetadata, AirlineMetadata } from '@/app/decoders/adsb/types';
import { AIRCRAFT_FORMAT, AIRLINE_FORMAT } from './offline';
import { lookupSnapshot } from './snapshot';

export const DATABASE_SOURCE = 'https://github.com/jLynx/WebSDR/blob/master/docs/aircraft-database.md';

async function aircraftRecord(icao: string, offlineOnly: boolean): Promise<AircraftMetadata | undefined> {
	const key = icao.toUpperCase();
	if (!/^[0-9A-F]{6}$/.test(key)) return undefined;
	const row = await lookupSnapshot(key, AIRCRAFT_FORMAT, offlineOnly);
	if (!row) return undefined;
	const [registration, manufacturer, model, type, owner, operator] = row;
	return { registration, manufacturer, model, type, owner, operator };
}

export function lookupAircraft(icao: string): Promise<AircraftMetadata | undefined> {
	return aircraftRecord(icao, false);
}

export function lookupOfflineAircraft(icao: string): Promise<AircraftMetadata | undefined> {
	return aircraftRecord(icao, true);
}

async function airlineRecord(callsign: string, offlineOnly: boolean): Promise<AirlineMetadata | undefined> {
	if (!/^[A-Z]{3}\d/.test(callsign)) return undefined;
	const row = await lookupSnapshot(callsign.slice(0, 3), AIRLINE_FORMAT, offlineOnly);
	return row ? { airline: row[0], country: row[1] } : undefined;
}

export function lookupAirline(callsign: string): Promise<AirlineMetadata | undefined> {
	return airlineRecord(callsign, false);
}

export function lookupOfflineAirline(callsign: string): Promise<AirlineMetadata | undefined> {
	return airlineRecord(callsign, true);
}

export function aircraftClassification(code = ''): { type?: string; engines?: string; engineType?: string } {
	const types: Record<string, string> = {
		L: 'Landplane',
		S: 'Seaplane',
		A: 'Amphibian',
		H: 'Helicopter',
		G: 'Gyrocopter',
		T: 'Tilt-wing aircraft',
	};
	const engines: Record<string, string> = { P: 'Piston', T: 'Turboprop / turboshaft', J: 'Jet', E: 'Electric' };
	if (/^[LSAHGT][0-9C][PTJE]$/.test(code)) {
		return { type: types[code[0]], engines: code[1] === 'C' ? 'Coupled' : code[1], engineType: engines[code[2]] };
	}
	const special: Record<string, string> = {
		SHIP: 'Airship',
		BALL: 'Balloon',
		GLID: 'Glider / sailplane',
		ULAC: 'Micro / ultralight aircraft',
		GYRO: 'Micro / ultralight autogyro',
		UHEL: 'Micro / ultralight helicopter',
		PARA: 'Powered parachute / paraplane',
	};
	return { type: special[code] ?? (code || undefined) };
}
