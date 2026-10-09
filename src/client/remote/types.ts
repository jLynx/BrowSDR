import type { BleMessage } from '@/worker/decoders/ble/types';
import type { AisMessage } from '@/worker/decoders/ais/types';
import type { AcarsMessage } from '@/worker/decoders/acars/types';
import type { DataConnection } from 'peerjs';
import type { DeviceCapabilities } from '@/radio/types';
import type { RadioState } from '@/app/core/types';
import type { VfoParams, PerfReport } from '@/worker/runtime/types';
import type { AdsbMessage } from '@/worker/decoders/adsb/types';
import type { POCSAGMessage, RDSMessage, Rtl433Message } from '@/worker/decoders/types';

export interface ReceiverInventory {
	id: string;
	name: string;
	running: boolean;
	radio: RadioState;
	gains: Record<string, number>;
	locks: Record<string, boolean>;
	capabilities: DeviceCapabilities | null;
}
export type StatusMessage =
	| { status: 'ready'; id: string }
	| { status: 'client-connected' | 'client-disconnected'; clientId: string; isRelay?: boolean }
	| { status: 'error'; error: string }
	| { status: 'connecting' | 'connected' | 'disconnected' };
export type DspStats = PerfReport & {
	squelchOpen?: boolean[];
	squelchDb?: number[];
	channelization?: { bands: number; vfos: number; sampleRate: number };
	audioQueueMs?: number;
	whisperEnabled?: boolean;
};
export type RemoteCommand =
	| {
			type: 'sync';
			capabilities?: DeviceCapabilities | null;
			radio?: RadioState;
			gains?: Record<string, number>;
			locks?: Record<string, boolean>;
	  }
	| { type: 'receivers'; receivers: ReceiverInventory[] }
	| { type: 'clientInfo'; country?: string; deviceId?: string }
	| { type: 'dspStats'; stats: DspStats }
	| { type: 'clientDisplay'; sharedChannelization: boolean }
	| { type: 'vfoUpdate'; index: number; params: VfoParams }
	| { type: 'resetRemoteVfos' }
	| { type: 'addRemoteVfo' }
	| { type: 'removeRemoteVfo'; index: number }
	| { type: 'ble'; vfoIndex: number; freq: number; msg: BleMessage }
	| { type: 'ais'; vfoIndex: number; freq: number; msg: AisMessage }
	| { type: 'acars'; vfoIndex: number; freq: number; msg: AcarsMessage }
	| { type: 'adsb'; vfoIndex: number; freq: number; msg: AdsbMessage }
	| { type: 'rtl433'; vfoIndex: number; freq: number; msg: Rtl433Message }
	| { type: 'pocsag'; vfoIndex: number; freq: number; msg: POCSAGMessage }
	| { type: 'rds'; vfoIndex: number; freq: number; msg: RDSMessage }
	| { type: 'squelchState'; squelchOpen: boolean[] }
	| { type: 'requestChange'; target: string; property: string; value: number };
export type ReceiverCommand = RemoteCommand & { receiverId?: string };
export type CommandCallbackHost = (clientId: string, command: ReceiverCommand) => void;
export type CommandCallbackClient = (command: ReceiverCommand) => void;

export interface ClientEntry {
	cmd: DataConnection | null;
	fft: DataConnection | null;
	audio: DataConnection | null;
	fftOverflow: boolean;
	audioOverflow: boolean;
	isRelay: boolean;
}

export type StatusChangeCallback = (msg: StatusMessage) => void;

export type ChunkCallback = (data: ArrayBuffer) => void;

export type RemoteClients = Array<{
	id: string;
	deviceId?: string;
	connectedAt: number;
	country: string;
	vfoCount: number;
	firstFreq: number | null;
	isRelay: boolean;
}>;
