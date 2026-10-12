export interface CprFrame {
	latitude: number;
	longitude: number;
	odd: boolean;
	time: number;
	gnss: boolean;
}

export interface Aircraft {
	icao: string;
	callsign?: string;
	category?: number;
	squawk?: string;
	altitude?: number;
	altitudeSource?: 'barometric' | 'GNSS';
	speed?: number;
	heading?: number;
	verticalRate?: number;
	latitude?: number;
	longitude?: number;
	positionTime?: number;
	lastSeen: number;
	messages: number;
}

export interface AircraftState extends Aircraft {
	even?: CprFrame;
	odd?: CprFrame;
}

export interface AdsbStatus {
	state: 'off' | 'receiving' | 'error';
	message: string;
	samples: number;
	frames: number;
}

export interface AdsbMessage {
	type: 'adsb';
	freq: number;
	status: AdsbStatus;
	aircraft: Aircraft[];
}
