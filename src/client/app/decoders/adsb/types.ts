export interface AircraftMetadata {
	registration: string;
	manufacturer: string;
	model: string;
	type: string;
	owner: string;
	operator: string;
}

export interface AirlineMetadata {
	airline: string;
	country: string;
}

export interface MetadataProvider {
	lookupAircraft(icao: string): Promise<AircraftMetadata | undefined>;
	lookupAirline(callsign: string): Promise<AirlineMetadata | undefined>;
}
