import type { RtkStation } from '@/worker/decoders/rtk/types';

export interface SurveyChannel {
	frequencyMHz: number;
	seconds: number;
}

export interface Evidence {
	count: number;
	confirmed: boolean;
	lastTime: number;
	frequencies: number[];
	station?: RtkStation;
	lastTracked?: { packets: number; rtcmCount: number; rtcmTypes: Record<string, number> };
}
