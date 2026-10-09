import type { AisMessage } from '@/worker/decoders/ais/types';
import type { AdsbMessage } from '@/worker/decoders/adsb/types';
import type { VfoParams } from './types';
import type { RDSMessage, Rtl433Message } from '@/worker/decoders/types';
import type { DSDStatus } from '@/worker/decoders/dsd/types';

export type DspOutput =
	| DspAudio
	| Rtl433Message
	| AdsbMessage
	| AisMessage
	| { type: 'rds'; msg: RDSMessage }
	| { type: 'dsd_status'; status: DSDStatus }
	| { type: 'dsp_debug_log'; level: 'log' | 'warn' | 'error'; message: string }
	| { type: 'error'; error: string; inputSamples?: number; chunkId?: number }
	| { type: 'processed'; chunkId: number }
	| { type: 'channel_error'; error: string; inputSamples: number }
	| { type: 'init_done' | 'config_done' }
	| {
			type: 'bands';
			bands: Array<{ centerBin: number; buffer: ArrayBuffer | SharedArrayBuffer; length: number }>;
			key: string;
			chunkId: number;
			inputSamples: number;
			dspTime: number;
	  };

export type DspInput =
	| {
			type: 'channelize';
			key: string;
			ratio: number;
			centers: number[];
			sampleRate: number;
			chunk: ArrayBuffer;
			chunkId: number;
			inputSamples: number;
	  }
	| { type: 'init'; sampleRate: number; centerFreq: number; params: VfoParams; sabs?: SharedArrayBuffer[] }
	| { type: 'configure'; centerFreq: number; params: VfoParams }
	| {
			type: 'process';
			sampleRate?: number;
			centerFreq?: number;
			params: VfoParams;
			floatIq?: boolean;
			useSab?: boolean;
			sabIndex?: number;
			chunkLen: number;
			chunk?: ArrayBuffer | SharedArrayBuffer;
			chunkId: number;
	  };

export interface DspAudio {
	channels?: 1 | 2;
	type: 'audio';
	samples: ArrayBuffer | null;
	chunkId: number;
	squelchOpen: boolean;
	squelchDb: number;
	dspTime: number;
}
