import type { VfoParams } from '@/worker/runtime/types';

export interface SharedBand {
	centerBin: number;
	centerFreq: number;
	vfos: number[];
}

export interface ChannelPlan {
	ratio: number;
	sampleRate: number;
	bands: SharedBand[];
	direct: number[];
}

export interface ChannelState {
	worker?: Worker;
	plan?: ChannelPlan;
	targets: Array<{ worker: Worker; params: VfoParams; shared: boolean }>;
	pending: number;
	key: string;
	perf: { calls: number; sum: number; max: number };
}
