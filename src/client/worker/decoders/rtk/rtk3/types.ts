import type { Rtk3Containers } from './containers';

export interface Rtk3Frame {
	address: number;
	addressPrefix?: number;
	body: Uint8Array;
	beaconMs?: number;
}

export interface Rtk3Container {
	type: number;
	sequence: number;
	payload: Uint8Array;
}

export interface BaseStream {
	containers: Rtk3Containers;
	lastSeen: number;
	beaconMs?: number;
}
