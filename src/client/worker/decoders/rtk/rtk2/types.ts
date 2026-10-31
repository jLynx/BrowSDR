export interface Rtk2Frame {
	format: 'container' | 'compact';
	network: string;
	loc?: number;
	address: number;
	sequence?: number;
	hopSlot?: number;
	beaconSeconds?: number;
	body: Uint8Array;
}

export interface BaseStream {
	partial: Uint8Array;
	sequence?: number;
	format?: 'container' | 'compact';
	beaconSeconds?: number;
	lastSeen: number;
}
