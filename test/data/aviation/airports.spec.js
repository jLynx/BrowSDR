import { describe, expect, it } from 'vitest';
import { airportName, airportDescription } from '@/data/aviation/airports';
import rows from '@/data/aviation/airports.json';
import metadata from '@/data/aviation/metadata.json';

describe('offline global airport reference', () => {
	it('indexes every explicitly coded source record without geographic or airport-type filtering', () => {
		expect(rows).toHaveLength(metadata.airportCount);
		expect(rows.filter((row) => row[1])).toHaveLength(metadata.icaoCount);
		expect(rows.filter((row) => row[2])).toHaveLength(metadata.iataCount);
		expect(metadata.icaoCount).toBeGreaterThan(10000);
		expect(metadata.iataCount).toBeGreaterThan(9000);
		const codes = new Set();
		for (const [name, icao, iata] of rows) {
			for (const code of [icao, iata].filter(Boolean)) {
				expect(codes.has(code)).toBe(false);
				codes.add(code);
				expect(airportName(code)).toBe(name);
			}
		}
	});
	it.each([
		['NZWN', 'WLG', 'Wellington International Airport'],
		['NZQN', 'ZQN', 'Queenstown Airport'],
		['NCRG', 'RAR', 'Rarotonga International Airport'],
		['EGLL', 'LHR', 'London Heathrow Airport'],
		['KJFK', 'JFK', 'John F. Kennedy International Airport'],
		['RJTT', 'HND', 'Tokyo Haneda International Airport'],
		['FAOR', 'JNB', 'O.R. Tambo International Airport'],
		['SBGR', 'GRU', 'São Paulo/Guarulhos–Governor André Franco Montoro International Airport'],
	])('resolves ICAO %s and IATA %s to the same airport', (icao, iata, name) => {
		expect(airportDescription(icao)).toBe(`${icao} · ${name}`);
		expect(airportDescription(iata)).toBe(`${iata} · ${name}`);
	});
	it.each(['ZZZZ', 'XYZ', 'NZ', 'nzaa', 'K00A', '<script>'])('preserves unknown or non-airport identifier %s', (code) => {
		expect(airportName(code)).toBeUndefined();
		expect(airportDescription(code)).toBe(code);
	});
});
