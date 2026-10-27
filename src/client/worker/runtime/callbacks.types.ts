import type { BleMessage } from '@/worker/decoders/ble/types';
import type { AisMessage } from '@/worker/decoders/ais/types';
import type { RadiosondeMessage } from '@/worker/decoders/radiosonde/types';
import type { AcarsMessage } from '@/worker/decoders/acars/types';
import type { AdsbMessage } from '@/worker/decoders/adsb/types';
import type { DSDStatus } from '@/worker/decoders/dsd/types';
import type {
	Rtl433Message,
	POCSAGMessage,
	POCSAGStatus,
	RDSMessage,
	GSCMessage,
	GSCStatus,
	FlexMessage,
	FlexStatus,
	RdsStatus,
} from '@/worker/decoders/types';
import type { PerfReport } from './types';

export type SamplesCallback = (samples: Float32Array) => void;
export type AudioCallback = (samples: Float32Array, channels?: 1 | 2) => void;
export type WhisperCallback = (index: number, freq: number, samples: Float32Array) => void;
export type DecoderCallback<T> = (index: number, freq: number, message: T) => void;
export type PocsagCallback = DecoderCallback<POCSAGMessage>;
export type PocsagStatusCallback = (index: number, freq: number, status: POCSAGStatus) => void;
export type GscCallback = DecoderCallback<GSCMessage>;
export type GscStatusCallback = (index: number, freq: number, status: GSCStatus) => void;
export type FlexCallback = DecoderCallback<FlexMessage>;
export type FlexStatusCallback = (index: number, freq: number, status: FlexStatus) => void;
/** Bundle of the pager-decoder callbacks (POCSAG + GSC + FLEX), passed together
 * so adding a protocol does not grow every stream signature. */
export interface PagerCallbacks {
	pocsag: PocsagCallback | null;
	pocsagStatus: PocsagStatusCallback | null;
	gsc: GscCallback | null;
	gscStatus: GscStatusCallback | null;
	flex: FlexCallback | null;
	flexStatus: FlexStatusCallback | null;
}
export type RdsCallback = DecoderCallback<RDSMessage>;
export type RdsStatusCallback = (index: number, freq: number, status: RdsStatus) => void;
export type BleCallback = DecoderCallback<BleMessage>;
export type AisCallback = DecoderCallback<AisMessage>;
export type RadiosondeCallback = DecoderCallback<RadiosondeMessage>;
export type AcarsCallback = DecoderCallback<AcarsMessage>;
export type AdsbCallback = DecoderCallback<AdsbMessage>;
export type Rtl433Callback = DecoderCallback<Rtl433Message>;
export type DsdCallback = (index: number, status: DSDStatus) => void;
export type HostCallback<T extends unknown[]> = (clientId: string, ...args: T) => void;
export type HostStats = PerfReport & { source: string; channelization: { bands: number; vfos: number; sampleRate: number } };
