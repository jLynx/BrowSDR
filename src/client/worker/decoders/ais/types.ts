export interface Vessel {
	mmsi: string;
	lastSeen: number;
	messages: number;
	name?: string;
	callsign?: string;
	imo?: number;
	shipType?: number;
	destination?: string;
	draught?: number;
	navigationStatus?: number;
	speed?: number;
	course?: number;
	heading?: number;
	latitude?: number;
	longitude?: number;
	positionTime?: number;
}

export interface AisStatus {
	state: 'off' | 'receiving' | 'error';
	message: string;
	samples: number;
	frames: number;
}

export interface AisMessage {
	type: 'ais';
	freq: number;
	status: AisStatus;
	vessels: Vessel[];
}

export type VesselReport = Partial<Vessel> & { mmsi: string };
