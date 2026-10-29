export const APRS_STATION_LIMIT = 500;
export const APRS_PACKET_LIMIT = 200;
export const APRS_TRAIL_LIMIT = 100;
/** Fixed stations commonly beacon every 10–30 minutes. */
export const APRS_STATION_TTL = 3600000;

export interface Ax25Frame {
	destination: string;
	source: string;
	/** Digipeaters in TNC2 order; the last repeated one carries a trailing `*`. */
	path: string[];
	control: number;
	pid?: number;
	info: Uint8Array;
}

export type AprsKind =
	'position' | 'object' | 'item' | 'message' | 'status' | 'telemetry' | 'weather' | 'capabilities' | 'query' | 'other' | 'ax25';

export type AprsPositionFormat = 'uncompressed' | 'compressed' | 'mic-e' | 'nmea';

/** Converted to metric units: m/s, °C, hPa, mm and W/m². */
export interface AprsWeather {
	windDirection?: number;
	windSpeed?: number;
	windGust?: number;
	temperature?: number;
	humidity?: number;
	pressure?: number;
	rain1h?: number;
	rain24h?: number;
	rainSinceMidnight?: number;
	luminosity?: number;
	snow24h?: number;
}

export interface AprsTelemetry {
	sequence: string;
	analog: number[];
	digital?: string;
}

/** PARM/UNIT/EQNS/BITS definitions a station sends to itself. */
export interface AprsTelemetryDefinition {
	names?: string[];
	units?: string[];
	/** Five `[a, b, c]` coefficients for `a·x² + b·x + c`. */
	equations?: number[][];
	bits?: string;
	project?: string;
	/** When the PARM, UNIT, EQNS and BITS messages were heard; each sets its part independently. */
	namesTime?: number;
	unitsTime?: number;
	equationsTime?: number;
	bitsTime?: number;
}

/** Power in W, antenna height above average terrain in m, gain in dBi; directivity 0 is omnidirectional. */
export interface AprsPhg {
	power: number;
	height: number;
	gain: number;
	directivity: number;
}

export interface AprsTextMessage {
	kind: 'message' | 'ack' | 'reject' | 'bulletin' | 'telemetry-definition';
	addressee: string;
	text: string;
	id?: string;
}

/** Parsed APRS information field. Speeds are km/h, altitude and range are metres/kilometres. */
export interface AprsReport {
	kind: AprsKind;
	format?: AprsPositionFormat;
	latitude?: number;
	longitude?: number;
	/** Number of trailing position digits withheld by the sender (1–4). */
	ambiguity?: number;
	symbol?: string;
	course?: number;
	speed?: number;
	altitude?: number;
	range?: number;
	phg?: AprsPhg;
	comment?: string;
	timestamp?: string;
	messaging?: boolean;
	name?: string;
	killed?: boolean;
	micEStatus?: string;
	message?: AprsTextMessage;
	status?: string;
	telemetry?: AprsTelemetry;
	weather?: AprsWeather;
}

export interface AprsPacket extends AprsReport {
	id: number;
	receivedAt: number;
	source: string;
	destination: string;
	path: string[];
	/** Printable information field: bytes outside 0x20–0x7e appear as `<0xNN>`. */
	info: string;
	/** Station that relayed a third-party packet. */
	relay?: string;
	/** Same source and information heard again within the duplicate window, usually via a digipeater. */
	duplicate?: boolean;
}

export interface AprsTrailPoint {
	latitude: number;
	longitude: number;
	time: number;
}

export interface AprsStation {
	id: string;
	type: 'station' | 'object' | 'item';
	/** Object and item originator. */
	owner?: string;
	lastSeen: number;
	packets: number;
	destination?: string;
	path?: string;
	symbol?: string;
	latitude?: number;
	longitude?: number;
	ambiguity?: number;
	positionTime?: number;
	course?: number;
	speed?: number;
	altitude?: number;
	range?: number;
	phg?: AprsPhg;
	comment?: string;
	messaging?: boolean;
	micEStatus?: string;
	killed?: boolean;
	status?: string;
	statusTime?: number;
	weather?: AprsWeather;
	weatherTime?: number;
	telemetry?: AprsTelemetry;
	telemetryTime?: number;
	telemetryDefinition?: AprsTelemetryDefinition;
	trail: AprsTrailPoint[];
}

export interface AprsStatus {
	state: 'off' | 'receiving' | 'error';
	message: string;
	samples: number;
	frames: number;
}

export interface AprsMessage {
	type: 'aprs';
	freq: number;
	status: AprsStatus;
	stations: AprsStation[];
	packets: AprsPacket[];
}
