import type { RtkStation } from '@/worker/decoders/rtk/types';
import type { RtkDiscoveryCatalog } from './catalog';
import type { RtkSurvey } from './survey';

export interface ActivityLane {
	catalog: RtkDiscoveryCatalog;
	survey?: RtkSurvey;
	frequencyMHz: number;
	deadline: number;
	extended: boolean;
	cursor: number;
	origin: number;
	retried: boolean;
	packetsAtStart: number;
}

export interface DiscoveryProof {
	frames: Array<{ time: number; hash: number }>;
	confirmed: boolean;
	lastTime: number;
}

export interface SurveyChannel {
	frequencyMHz: number;
	seconds: number;
}

export interface Evidence {
	fixed?: boolean;
	count: number;
	confirmed: boolean;
	lastTime: number;
	frequencies: number[];
	latestFrequency?: number;
	station?: RtkStation;
	lastTracked?: { packets: number; rtcmCount: number; rtcmTypes: Record<string, number> };
}
