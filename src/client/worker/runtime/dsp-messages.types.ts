import type { BleMessage } from '@/worker/decoders/ble/types';
import type { AisMessage } from '@/worker/decoders/ais/types';
import type { RadiosondeMessage } from '@/worker/decoders/radiosonde/types';
import type { AcarsMessage } from '@/worker/decoders/acars/types';
import type { AdsbMessage } from '@/worker/decoders/adsb/types';
import type { VfoParams } from './types';
import type { RDSMessage, RdsStatus, Rtl433Message } from '@/worker/decoders/types';
import type { DSDStatus } from '@/worker/decoders/dsd/types';
import type { PagerProtocol } from '@/worker/decoders/charsets';

export interface SharedBandOutput {
	centerBin: number;
	buffer: ArrayBuffer | SharedArrayBuffer;
	length: number;
}

export type DspOutput =
	| DspAudio
	| Rtl433Message
	| AdsbMessage
	| AisMessage
	| RadiosondeMessage
	| BleMessage
	| AcarsMessage
	| { type: 'rds'; msg: RDSMessage }
	| { type: 'rds_status'; status: RdsStatus }
	| { type: 'dsd_status'; status: DSDStatus }
	| { type: 'dsp_debug_log'; level: 'log' | 'warn' | 'error'; message: string }
	| { type: 'error'; error: string; inputSamples?: number; chunkId?: number }
	| { type: 'processed'; chunkId: number }
	| { type: 'channel_error'; error: string; inputSamples: number }
	| { type: 'init_done' | 'config_done' }
	| {
			type: 'bands';
			bands: SharedBandOutput[];
			batchId?: number;
			dropped?: boolean;
			discontinuity?: boolean;
			key: string;
			chunkId: number;
			inputSamples: number;
			dspTime: number;
	  };

export type DspInput =
	| { type: 'release_bands'; batchId: number }
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
			sequence?: number;
	  };

export interface DspAudio {
	channels?: 1 | 2;
	type: 'audio';
	samples: ArrayBuffer | null;
	chunkId: number;
	squelchOpen: boolean;
	squelchDb: number;
	dspTime: number;
	/**
	 * When set, this buffer is a pager channel leg demodulated at the protocol's
	 * own RX bandwidth and must feed ONLY that protocol's decoder, not playback,
	 * whisper, or the other pager decoders. An untagged buffer is the main VFO
	 * audio (voice/playback) and carries no pager decode.
	 */
	pager?: PagerProtocol;
}
