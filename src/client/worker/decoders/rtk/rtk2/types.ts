export interface BaseStream {
	partial: Uint8Array;
	sequence?: number;
	lastSeen: number;
}
