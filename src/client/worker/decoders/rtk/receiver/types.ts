import type { LoraPacket, RtkProfile } from '@/worker/decoders/rtk/types';
import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';

export interface RadioObservation {
	profile: RtkProfile;
	packet: LoraPacket;
	frequencyHz: number;
	time: number;
}
export interface VerifiedObservation extends RadioObservation {
	source: string;
	beacon: boolean;
}

export interface IqInput {
	ptr: number;
	values: number;
	floatInput: boolean;
}

export interface ChannelOptions {
	takeDdc?: () => DspProcessor | undefined;
	searchBoth250?: boolean;
	filterInput?: boolean;
	observerOnly?: boolean;
	invalid?: () => void;
}
