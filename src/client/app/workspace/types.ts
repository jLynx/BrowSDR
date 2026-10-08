import type { Component } from 'vue';
import type { AppInstance } from '../core/instance';
import type { Bookmark } from '../core/types';
import type { CapabilityIssue } from '../../platform/browser-capabilities';
import type { WatchOptions, WatchStopHandle } from 'vue';
import type { ReceiverInventory } from '../../remote/types';

export interface ReceiverEntry {
	id: string;
	label: string;
	settingsKey: string;
	status: string;
	remote?: boolean;
	deviceLabel?: string;
}
export interface WorkspaceData {
	receivers: ReceiverEntry[];
	selectedId: string;
	mode: string;
	error: string;
	remoteStatus: string;
	shareLink: string;
	controller: WorkspaceInstance | null;
	remoteCapabilityIssue: CapabilityIssue | null;
	bookmarks: Bookmark[];
}
export interface WorkspaceInstance extends WorkspaceData {
	_removeUsbListener?: () => void;
	_disconnecting?: boolean;
	$nextTick(callback?: () => void): Promise<void>;
	$watch<T>(source: () => T, callback: () => void, options?: WatchOptions): WatchStopHandle;
	updateMediaSession(): void;
	registerReceiver(id: string, app: AppInstance): boolean;
	newReceiver(entry?: ReceiverEntry): Promise<AppInstance | null>;
	selectReceiver(id: string): void;
	addDevice(): Promise<void>;
	isDeviceConnected(device: USBDevice): boolean;
	connectDevice(source: AppInstance, device: USBDevice | 'mock'): Promise<void>;
	removeReceiver(id: string): Promise<void>;
	broadcastReceivers(clientId?: string): void;
	attachHostReceiver(app: AppInstance): Promise<void>;
	startSharing(): Promise<void>;
	stopSharing(): Promise<void>;
	regenerateShareCode(): Promise<void>;
	connectRemote(hostId: string): Promise<void>;
	applyReceivers(inventory: ReceiverInventory[], hostId: string): Promise<void>;
	disconnectRemote(): Promise<void>;
}
export type ReceiverComponent = Component;
export type ReceiverInstance = AppInstance;
