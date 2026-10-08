import type Peer from 'peerjs';
export {};
declare global {
	interface Window {
		Peer: typeof Peer;
	}
}
