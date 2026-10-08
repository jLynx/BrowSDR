import type { DeviceCapabilities } from '../radio/sdr-device';
import type { RadioState } from '../app/core/types';
import type { VfoParams, PerfReport, POCSAGMessage, RDSMessage } from '../worker/runtime/types';
import type { Rtl433Message } from '../worker/decoders/rtl433';

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
	| { type: 'rtl433'; vfoIndex: number; freq: number; msg: Rtl433Message }
	| { type: 'pocsag'; vfoIndex: number; freq: number; msg: POCSAGMessage }
	| { type: 'rds'; vfoIndex: number; freq: number; msg: RDSMessage }
	| { type: 'squelchState'; squelchOpen: boolean[] }
	| { type: 'requestChange'; target: string; property: string; value: number };
export type ReceiverCommand = RemoteCommand & { receiverId?: string };
export type CommandCallbackHost = (clientId: string, command: ReceiverCommand) => void;
export type CommandCallbackClient = (command: ReceiverCommand) => void;
