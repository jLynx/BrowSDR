export type RtkProfile = 'luba1' | 'lower' | 'rtk2' | 'rtk3';

export interface LoraProfile {
	bandwidth: number;
	oversample: number;
	sync: [number, number];
	ldro: boolean;
}

export interface LoraHeader {
	length: number;
	codingRate: number;
	hasCrc: boolean;
	symbols: number;
}

export interface LoraPacket {
	data: Uint8Array;
	verified: boolean;
	hasCrc: boolean;
	codingRate: number;
	cfoHz: number;
	codingErrors?: number;
}

export interface RtkStatus {
	state: 'off' | 'receiving' | 'error';
	message: string;
	samples: number;
	syncs: number;
	headers: number;
	payloads?: number;
	codingErrors?: number;
	packets: number;
	crcErrors: number;
	discontinuities: number;
	syncSymbols?: [number, number];
	beacons?: number;
	containers?: number;
	containerErrors?: number;
	sequenceGaps?: number;
}

export interface RtkIdentity {
	protocol?: 'rtk2';
	network?: string;
	scan?: number;
	channel?: number;
	netId: number;
	address?: number;
}

export interface RtkStation extends RtkIdentity {
	name: string;
	packets: number;
	lastSeen: number;
	lastCorrection?: number;
	rtcmCount: number;
	rtcmTypes: Record<string, number>;
	cfoHz: number;
	reference?: RtcmReference;
	observations?: Record<string, RtcmObservation>;
	equipment?: RtcmEquipment;
}

export interface RtcmReference {
	stationId: number;
	itrf: number;
	latitude: number;
	longitude: number;
	heightM: number;
	antennaHeightM?: number;
	ecef: [number, number, number];
}

export interface RtcmObservation {
	type: number;
	stationId: number;
	constellation: string;
	epochMs: number;
	day?: number;
	multipleMessage: boolean;
	satellites: number[];
	signals: number[];
	cells: number;
	cnrDbHz: number[];
	measurements?: RtcmSignalObservation[];
	receivedAt: number;
}

export interface RtcmSignalObservation {
	satellite: number;
	signal: number;
	cnrDbHz: number;
	band?: string;
	group?: 'primary' | 'secondary' | 'other';
}

export interface RtcmEquipment {
	stationId: number;
	antenna: string;
	setupId: number;
	antennaSerial: string;
	receiver: string;
	firmware: string;
	receiverSerial: string;
}

export interface RtkMessage {
	type: 'rtk';
	freq: number;
	profile?: RtkProfile;
	status: RtkStatus;
	stations: RtkStation[];
	rtcm: Array<{ type: number; stationId: number; source?: string; data: Uint8Array }>;
}
