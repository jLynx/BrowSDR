import type { DataConnection } from 'peerjs';

export interface BandwidthSnapshot {
	uploadBps: number;
	downloadBps: number;
	peers: number;
	ready: boolean;
	unavailable: boolean;
}

export interface BandwidthStreams {
	cmd: DataConnection | null;
	fft: DataConnection | null;
	audio: DataConnection | null;
}

export interface BandwidthSource {
	isHost: boolean;
	clients: Map<string, BandwidthStreams>;
	connCmd: DataConnection | null;
	connFft: DataConnection | null;
	connAudio: DataConnection | null;
}

export interface BandwidthCounter {
	time: number;
	sent: number;
	received: number;
}
