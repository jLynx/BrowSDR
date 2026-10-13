export interface SondePosition {
	latitude: number;
	longitude: number;
	altitude: number;
	time: number;
}

export interface Radiosonde {
	id: string;
	model: 'RS41';
	frame: number;
	lastSeen: number;
	messages: number;
	frequency: number;
	battery?: number;
	latitude?: number;
	longitude?: number;
	altitude?: number;
	positionTime?: number;
	speed?: number;
	course?: number;
	climb?: number;
	satellites?: number;
	gpsTime?: number;
	maxAltitude?: number;
	temperature?: number;
	humiditySensorTemperature?: number;
	humidity?: number;
	pressure?: number;
	estimatedPressure?: number;
	pressureSensorTemperature?: number;
	dewPoint?: number;
	weatherTime?: number;
	subtype?: string;
	mainboard?: string;
	mainboardSerial?: string;
	pressureSensorSerial?: string;
	firmware?: number;
	txFrequency?: number;
	txPower?: number;
	referenceTemperature?: number;
	flightPhase?: 'startup' | 'ascent' | 'descent';
	burstKill?: boolean;
	burstTimer?: number;
	flightTimer?: number;
	killCountdown?: number;
	killCountdownTime?: number;
	statusFlags?: number;
	errorFlags?: number;
	cryptoMode?: number;
	humidityHeating?: number;
	positionDop?: number;
	speedAccuracy?: number;
	calibrationCount?: number;
	calibrationTotal?: number;
	calibrationComplete?: boolean;
	configuration?: SondeField[];
	rawBlocks?: SondeBlock[];
	calibrationFragments?: SondeFragment[];
	measurements?: number[];
	gnssSatellites?: SondeSatellite[];
	gnssJamming?: number;
	gnssAgc?: number;
	auxiliary?: string[];
	trail: SondePosition[];
}

export interface SondeSatellite {
	prn: number;
	signal: number;
	quality: number;
	pseudorange?: number;
	doppler?: number;
}

export interface SondeField {
	label: string;
	value: string | number;
	unit?: string;
}

export interface SondeBlock {
	type: number;
	data: string;
	crcValid: boolean;
}

export interface SondeFragment {
	index: number;
	data: string;
}

export interface Rs41Packet {
	telemetry: Partial<Radiosonde>;
	identity: Uint8Array;
	blocks: Map<number, Uint8Array>;
}

export interface RadiosondeStatus {
	state: 'off' | 'receiving' | 'error';
	message: string;
	samples: number;
	frames: number;
	syncs: number;
	crcErrors: number;
}

export interface RadiosondeMessage {
	type: 'radiosonde';
	freq: number;
	status: RadiosondeStatus;
	sondes: Radiosonde[];
}

export const SONDE_POSITION_TTL = 5 * 60 * 1000;
export const SONDE_TTL = 30 * 60 * 1000;
export const SONDE_LIMIT = 32;
export const SONDE_TRAIL_LIMIT = 300;
