import type { DSDStatus } from '../decoders/dsd/types';
import type { Rtl433Message } from '../decoders/rtl433';
import type { PerfReport, POCSAGMessage, RDSMessage } from './types';

export type SamplesCallback = (samples: Float32Array) => void;
export type WhisperCallback = (index: number, freq: number, samples: Float32Array) => void;
export type DecoderCallback<T> = (index: number, freq: number, message: T) => void;
export type PocsagCallback = DecoderCallback<POCSAGMessage>;
export type RdsCallback = DecoderCallback<RDSMessage>;
export type Rtl433Callback = DecoderCallback<Rtl433Message>;
export type DsdCallback = (index: number, status: DSDStatus) => void;
export type HostCallback<T extends unknown[]> = (clientId: string, ...args: T) => void;
export type HostStats = PerfReport & { source: string; channelization: { bands: number; vfos: number; sampleRate: number } };
