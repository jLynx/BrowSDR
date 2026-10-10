import rows from './airports.json';

const names = new Map<string, string>();
for (const [name, icao, iata] of rows) {
	if (icao) names.set(icao, name);
	if (iata) names.set(iata, name);
}

/** ICAO and IATA airport codes only; unknown codes remain exactly as received. */
export function airportName(code: string): string | undefined {
	return names.get(code);
}

export function airportDescription(code: string): string {
	const name = airportName(code);
	return name ? `${code} · ${name}` : code;
}
