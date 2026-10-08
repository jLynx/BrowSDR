import type { DSDStatus } from '@/worker/decoders/dsd/types';
import type { Rtl433Message, POCSAGMessage, RDSMessage } from '@/worker/decoders/types';
import type { PerfReport } from './types';

export type SamplesCallback = (samples: Float32Array) => void;
export type AudioCallback = (samples: Float32Array, channels?: 1 | 2) => void;
export type WhisperCallback = (index: number, freq: number, samples: Float32Array) => void;
export type DecoderCallback<T> = (index: number, freq: number, message: T) => void;
export type PocsagCallback = DecoderCallback<POCSAGMessage>;
export type RdsCallback = DecoderCallback<RDSMessage>;
export type Rtl433Callback = DecoderCallback<Rtl433Message>;
export type DsdCallback = (index: number, status: DSDStatus) => void;
export type HostCallback<T extends unknown[]> = (clientId: string, ...args: T) => void;
export type HostStats = PerfReport & { source: string; channelization: { bands: number; vfos: number; sampleRate: number } };
