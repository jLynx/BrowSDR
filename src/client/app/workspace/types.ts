import type { Vfo } from '@/app/core/types';
import type { Component, WatchOptions, WatchStopHandle } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { CapabilityIssue } from '@/platform/types';
import type { ReceiverInventory } from '@/remote/types';

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

export interface BookmarkModal {
	show: boolean;
	type: string;
	name: string;
	category: string;
}

export interface BookmarkImportModal {
	show: boolean;
}

export interface BookmarkEdit {
	show: boolean;
	index: number;
	type: string;
	name: string;
	category: string;
	freq: number;
	mode: string;
	bandwidth: number;
	snapInterval: number;
	deEmphasis: string;
	squelchEnabled: boolean;
	squelchLevel: number;
	noiseReduction: boolean;
	stereo: boolean;
	lowPass: boolean;
	highPass: boolean;
	rds: boolean;
	rdsRegion: string;
	volume: number;
	centerFreq: number;
	sampleRate: number;
	vfos: Vfo[];
	activeVfoIndex: number;
}

export interface BookmarkCategory {
	value: string;
	label: string;
}

export interface Bookmark {
	type: string;
	name: string;
	category?: string;
	id?: string;
	freq?: number;
	rtl433?: boolean;
	rtl433SampleRate?: number;
	rtl433Protocols?: string;
	mode?: string;
	bandwidth?: number;
	snapInterval?: number;
	deEmphasis?: string;
	squelchEnabled?: boolean;
	squelchLevel?: number;
	noiseReduction?: boolean;
	stereo?: boolean;
	lowPass?: boolean;
	highPass?: boolean;
	rds?: boolean;
	rdsRegion?: string;
	volume?: number;
	// group fields
	centerFreq?: number;
	sampleRate?: number;
	vfos?: Vfo[];
	activeVfoIndex?: number;
}

export type BookmarkEntry = { bm: Bookmark; i: number };
