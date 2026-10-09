export interface BleAdvertisement {
	address: string;
	addressType: 'public' | 'random';
	pduType: string;
	channel: number;
	name?: string;
	completeName?: boolean;
	services: string[];
	manufacturer?: number;
	manufacturerData?: string;
	serviceData: string[];
	txPower?: number;
	data: string;
	signalDbfs: number;
}

export interface BleDevice extends BleAdvertisement {
	firstSeen: number;
	lastSeen: number;
	packets: number;
	channels: number[];
}

export interface BleStatus {
	state: 'off' | 'receiving' | 'error';
	message: string;
	samples: number;
	frames: number;
}

export interface BleMessage {
	type: 'ble';
	freq: number;
	status: BleStatus;
	advertisements: BleAdvertisement[];
}

export interface BleLane {
	access: number;
	preamble: number;
	bytes: Uint8Array;
	bits: number;
	length: number;
	whitening: number;
	polarity: number;
	power: number;
	collecting: boolean;
}
