import type { RtkProfile, RtkProfileMode, RtkStation, RtkStatus } from '@/worker/decoders/rtk/types';

export type PairingField = 'scan' | 'channel' | 'loc' | 'netId';
export type PairingEstimates = Partial<Record<PairingField, number>>;

export interface RtkReport {
	frequency: number;
	profile: RtkProfileMode;
	status?: RtkStatus;
	stations: RtkStation[];
}

export interface RtkReception {
	running: boolean;
	enabled: boolean;
	local: boolean;
	inBand: boolean;
	status?: RtkStatus;
	station?: RtkStation;
	now: number;
}

export interface GnssSummary {
	primary?: number;
	secondary?: number;
	primarySignals?: number;
	secondarySignals?: number;
	bands: Record<string, number>;
	meanCnr?: number;
	quality: 'Good' | 'Fair' | 'Weak' | 'Unavailable';
	tone: 'good' | 'fair' | 'weak' | 'idle';
}

export interface RtkStationEntry {
	key: string;
	source: string;
	frequency: number;
	profile: RtkProfile;
	indices: number[];
	station: RtkStation;
	reception: { label: string; detail: string; tone: string };
	satellites?: number;
}
