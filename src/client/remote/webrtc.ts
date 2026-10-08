import type Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import type { ReceiverCommand, CommandCallbackHost, CommandCallbackClient } from './types';
import { isReceiverCommand } from './validation';
import { isRecord } from '../platform/data';
import { errorMessage } from '../platform/errors';
interface ClientEntry {
	cmd: DataConnection | null;
	fft: DataConnection | null;
	audio: DataConnection | null;
	fftOverflow: boolean;
	audioOverflow: boolean;
	isRelay: boolean;
}

type StatusMessage =
	| { status: 'ready'; id: string }
	| { status: 'client-connected' | 'client-disconnected'; clientId: string; isRelay?: boolean }
	| { status: 'error'; error: string }
	| { status: 'connecting' | 'connected' | 'disconnected' };

type StatusChangeCallback = (msg: StatusMessage) => void;
type ChunkCallback = (data: ArrayBuffer) => void;

/** Prefix prepended to all PeerJS IDs (hidden from users / share links). */
export const PEER_ID_PREFIX = 'browsdr-';

export class WebRTCHandler {
	isHost: boolean;
	peer: Peer | null;

	// --- Multi-client (host) ---
	// Map<peerId, ClientEntry>
	clients: Map<string, ClientEntry>;

	// --- Single-connection (client) ---
	connCmd: DataConnection | null;
	connFft: DataConnection | null;
	connAudio: DataConnection | null;
	connFftOverflow: boolean;
	connAudioOverflow: boolean;

	remoteId: string | null; // Used by client to connect to host
	preferredHostId: string | null; // Used by host to reuse a previous share code

	onStatusChange: StatusChangeCallback | null;
	onCommand: CommandCallbackHost | CommandCallbackClient | null;
	onFftChunk: ChunkCallback | null;
	onAudioChunk: ChunkCallback | null;

	constructor(isHost: boolean, remoteId: string | null = null, preferredHostId: string | null = null) {
		this.isHost = isHost;
		this.peer = null;

		// --- Multi-client (host) ---
		this.clients = new Map();

		// --- Single-connection (client) ---
		this.connCmd = null;
		this.connFft = null;
		this.connAudio = null;
		this.connFftOverflow = false;
		this.connAudioOverflow = false;

		this.remoteId = remoteId;
		this.preferredHostId = preferredHostId;

		this.onStatusChange = null;
		this.onCommand = null;
		this.onFftChunk = null;
		this.onAudioChunk = null;
	}

	async init(): Promise<string | false> {
		// Import peerjs dynamically from window.Peer since it's loaded as a script
		if (!window.Peer) {
			console.error('PeerJS not loaded!');
			return false;
		}

		// Fetch TURN credentials from our Cloudflare Worker endpoint
		let peerConfig: { iceServers: RTCIceServer[] } | undefined = undefined;
		try {
			const turnResp = await fetch('/api/turn');
			const turnData: unknown = await turnResp.json();
			if (isRecord(turnData) && Array.isArray(turnData.iceServers) && turnData.iceServers.length > 0) {
				const iceServers: RTCIceServer[] = turnData.iceServers.filter(
					(server: unknown): server is RTCIceServer =>
						isRecord(server) &&
						(typeof server.urls === 'string' ||
							(Array.isArray(server.urls) && server.urls.every((url: unknown) => typeof url === 'string'))) &&
						(server.username === undefined || typeof server.username === 'string') &&
						(server.credential === undefined || typeof server.credential === 'string'),
				);
				peerConfig = { iceServers };
				console.log('[WebRTC] TURN credentials loaded');
			} else {
				console.warn('[WebRTC] No TURN servers available, using STUN only');
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? errorMessage(err) : String(err);
			console.warn('[WebRTC] Failed to fetch TURN credentials:', msg);
		}

		return new Promise<string>((resolve, reject) => {
			const connectWithRetry = (retries: number) => {
				const peerOpts = peerConfig ? { config: peerConfig } : {};
				if (this.isHost) {
					// Reuse preferred ID if available, otherwise generate a new 5-char code
					const shortId = this.preferredHostId || Math.random().toString(36).substring(2, 7);
					this.peer = new window.Peer(PEER_ID_PREFIX + shortId, peerOpts);
				} else {
					// Client generates random id, will connect to this.remoteId
					this.peer = new window.Peer(peerOpts);
				}

				this.peer.on('open', (id: string) => {
					console.log('[WebRTC] Peer ID:', id);

					if (this.isHost) {
						this._setStatus({ status: 'ready', id: id });
					} else {
						this._setStatus({ status: 'connecting' });
						if (this.remoteId) {
							this._connectToHost();
						}
					}
					resolve(id);
				});

				this.peer.on('connection', (conn: DataConnection) => {
					if (this.isHost) {
						this._handleIncomingConnection(conn);
					}
				});

				this.peer.on('error', (err) => {
					if (this.isHost && err.type === 'unavailable-id' && retries > 0) {
						console.warn('[WebRTC] Generated ID was taken, retrying with new ID...');
						this.preferredHostId = null; // Don't reuse the taken ID
						this.peer?.destroy();
						connectWithRetry(retries - 1);
						return;
					}

					console.error('[WebRTC] PeerJS error:', err);
					this._setStatus({ status: 'error', error: err.type });
					reject(err);
				});

				this.peer.on('disconnected', () => {
					this._setStatus({ status: 'disconnected' });
				});
			};

			connectWithRetry(3);
		});
	}

	receiveHostCommand(clientId: string, command: ReceiverCommand): void {
		(this.onCommand as CommandCallbackHost | null)?.(clientId, command);
	}
	receiveClientCommand(command: ReceiverCommand): void {
		(this.onCommand as CommandCallbackClient | null)?.(command);
	}

	_setStatus(msgObj: StatusMessage): void {
		if (this.onStatusChange) this.onStatusChange(msgObj);
	}

	// Check whether a connection is using a TURN relay (vs direct peer-to-peer)
	async _checkRelayType(conn: DataConnection, clientId: string | null): Promise<boolean | null> {
		const pc: RTCPeerConnection | undefined = conn.peerConnection;
		if (!pc) return null;
		try {
			const stats = await pc.getStats();
			for (const [, value] of stats) {
				const report: unknown = value;
				if (
					isRecord(report) &&
					report.type === 'candidate-pair' &&
					report.state === 'succeeded' &&
					typeof report.localCandidateId === 'string'
				) {
					const localCandidate: unknown = stats.get(report.localCandidateId);
					if (isRecord(localCandidate) && typeof localCandidate.candidateType === 'string') {
						const isRelay: boolean = localCandidate.candidateType === 'relay';
						const label = clientId ? clientId.substring(0, 8) : 'host';
						if (isRelay) {
							console.warn(`[WebRTC] Client ${label} is using TURN relay`);
						} else {
							console.log(`[WebRTC] Client ${label} is connected peer-to-peer (${localCandidate.candidateType})`);
						}
						// Include relay status in client-connected event for host tracking
						if (this.isHost && clientId) {
							const client = this.clients.get(clientId);
							if (client) client.isRelay = isRelay;
						}
						return isRelay;
					}
				}
			}
		} catch (_) {
			/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
		}
		return null;
	}

	_connectToHost(): void {
		if (!this.peer || !this.remoteId) return;
		console.log('[WebRTC] Connecting to host...');
		// Client connects to Host. Open three channels.
		// serialization:'binary' is required for all channels that carry typed arrays.
		// Without it PeerJS defaults to binary-pack (msgpack) which wraps the
		// ArrayBuffer in a Uint8Array envelope -- Float32Array reconstruction on the
		// receiving end then produces garbage values or an array of the wrong length.
		this.connCmd = this.peer.connect(this.remoteId, { label: 'cmd', reliable: true, serialization: 'binary' });
		// 'raw' bypasses binarypack entirely -- send/receive as plain ArrayBuffer.
		// With 'binary' (binarypack), the receiver gets a Uint8Array; doing
		// new Float32Array(uint8Array) then numerically casts each byte (0-255)
		// instead of reinterpreting the raw bytes, producing garbage float values.
		this.connFft = this.peer.connect(this.remoteId, { label: 'fft', reliable: false, serialization: 'raw' });
		this.connAudio = this.peer.connect(this.remoteId, { label: 'audio', reliable: false, serialization: 'raw' });

		this._setupClientListeners(this.connCmd, 'cmd');
		this._setupClientListeners(this.connFft, 'fft');
		this._setupClientListeners(this.connAudio, 'audio');

		// Timeout: if not all channels open within 15s, dump diagnostic info
		setTimeout(() => {
			if (!(this.connCmd?.open && this.connFft?.open && this.connAudio?.open)) {
				console.warn('[WebRTC] Connection timeout after 15s. Not all channels opened.');
				const channels: Array<[string, DataConnection | null]> = [
					['cmd', this.connCmd],
					['fft', this.connFft],
					['audio', this.connAudio],
				];
				channels.forEach(([label, c]) => {
					const pc: RTCPeerConnection | undefined = c?.peerConnection;
					if (pc) {
						console.warn(`[WebRTC] ${label}: open=${c?.open}, ICE=${pc.iceConnectionState}, connection=${pc.connectionState}`);
					} else {
						console.warn(`[WebRTC] ${label}: no peerConnection`);
					}
				});
			}
		}, 15000);
	}

	// -- Host: incoming connection handling (multi-client) --

	_handleIncomingConnection(conn: DataConnection): void {
		const clientId: string = conn.peer;
		if (!this.clients.has(clientId)) {
			this.clients.set(clientId, { cmd: null, fft: null, audio: null, fftOverflow: false, audioOverflow: false, isRelay: false });
		}
		const client = this.clients.get(clientId)!;

		if (conn.label === 'cmd') {
			client.cmd = conn;
		} else if (conn.label === 'fft') {
			client.fft = conn;
		} else if (conn.label === 'audio') {
			client.audio = conn;
		}

		this._setupHostListeners(conn, conn.label, clientId);
	}

	_cleanupClient(clientId: string): void {
		const client = this.clients.get(clientId);
		if (!client) return;
		this.clients.delete(clientId);
		if (client.cmd)
			try {
				client.cmd.close();
			} catch (_) {
				/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
			}
		if (client.fft)
			try {
				client.fft.close();
			} catch (_) {
				/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
			}
		if (client.audio)
			try {
				client.audio.close();
			} catch (_) {
				/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
			}
		this._setStatus({ status: 'client-disconnected', clientId });
	}

	_setupHostListeners(conn: DataConnection, type: string, clientId: string): void {
		conn.on('open', () => {
			const client = this.clients.get(clientId);
			if (client && client.cmd && client.cmd.open && client.fft && client.fft.open && client.audio && client.audio.open) {
				// All 3 channels open -- check relay type on the cmd channel, then emit connected
				this._checkRelayType(client.cmd, clientId)
					.then((isRelay: boolean | null) => {
						this._setStatus({ status: 'client-connected', clientId, isRelay: !!isRelay });
					})
					.catch((error: unknown) => {
						console.warn('[WebRTC] Unable to detect relay type', error);
						this._setStatus({ status: 'client-connected', clientId, isRelay: false });
					});

				// Monitor ICE connection state to detect abrupt disconnects (e.g. tab close).
				// PeerJS 'close' events on DataChannels are not reliably fired when a
				// remote peer disappears without a graceful shutdown.
				const pc: RTCPeerConnection | undefined = client.cmd.peerConnection;
				if (pc) {
					pc.addEventListener('iceconnectionstatechange', () => {
						if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
							if (this.clients.has(clientId)) {
								console.log(`[WebRTC] ICE state "${pc.iceConnectionState}" for ${clientId.substring(0, 8)}, cleaning up`);
								this._cleanupClient(clientId);
							}
						}
					});
				}
			}
		});

		conn.on('data', (data: unknown) => {
			if (type === 'cmd') {
				if (isReceiverCommand(data)) this.receiveHostCommand(clientId, data);
			}
			// Host doesn't receive fft/audio from clients
		});

		conn.on('error', (err: Error) => {
			console.error(`[WebRTC] Channel error for ${clientId.substring(0, 8)}/${type}:`, err);
		});

		conn.on('close', () => {
			if (this.clients.has(clientId)) {
				this._cleanupClient(clientId);
			}
		});
	}

	// -- Client: connection listeners (single host) --

	_setupClientListeners(conn: DataConnection, type: string): void {
		conn.on('open', () => {
			if (this.connCmd && this.connCmd.open && this.connFft && this.connFft.open && this.connAudio && this.connAudio.open) {
				this._checkRelayType(this.connCmd, null).catch((error: unknown) => {
					console.warn('[WebRTC] Unable to detect relay type', error);
				});
				this._setStatus({ status: 'connected' });
			}
		});

		conn.on('data', (data: unknown) => {
			if (type === 'cmd') {
				if (isReceiverCommand(data)) this.receiveClientCommand(data);
			} else if (type === 'fft') {
				if (data instanceof ArrayBuffer) this.onFftChunk?.(data);
				else if (ArrayBuffer.isView(data)) this.onFftChunk?.(this._toArrayBuffer(data));
			} else if (type === 'audio') {
				if (data instanceof ArrayBuffer) this.onAudioChunk?.(data);
				else if (ArrayBuffer.isView(data)) this.onAudioChunk?.(this._toArrayBuffer(data));
			}
		});

		conn.on('error', (err: Error) => {
			console.error(`[WebRTC] ${type} channel error:`, err);
		});

		conn.on('close', () => {
			this._setStatus({ status: 'disconnected' });
		});
	}

	// -- Sending: Host -> Clients --

	sendCommand(cmd: ReceiverCommand): void {
		if (this.isHost) {
			// Broadcast to all clients
			for (const [, client] of this.clients) {
				if (client.cmd && client.cmd.open) {
					Promise.resolve(client.cmd.send(cmd)).catch((error: unknown) => console.error(error));
				}
			}
		} else {
			// Client sends to host
			if (this.connCmd && this.connCmd.open) {
				Promise.resolve(this.connCmd.send(cmd)).catch((error: unknown) => console.error(error));
			}
		}
	}

	sendCommandTo(clientId: string, cmd: ReceiverCommand): void {
		const client = this.clients.get(clientId);
		if (client && client.cmd && client.cmd.open) {
			Promise.resolve(client.cmd.send(cmd)).catch((error: unknown) => console.error(error));
		}
	}

	// Returns an ArrayBuffer that contains exactly the bytes of `chunk`.
	// If chunk is a typed-array view (e.g. a subarray of a larger buffer),
	// chunk.buffer is the ENTIRE backing buffer -- we must slice to the view bounds.
	_toArrayBuffer(chunk: ArrayBuffer | ArrayBufferView): ArrayBuffer {
		if (chunk instanceof ArrayBuffer) return chunk;
		const view = chunk;
		return (view.buffer as ArrayBuffer).slice(view.byteOffset, view.byteOffset + view.byteLength);
	}

	sendFftChunk(chunk: ArrayBuffer | ArrayBufferView): void {
		if (this.isHost) {
			const buf = this._toArrayBuffer(chunk);
			// Broadcast to all clients with per-client backpressure
			for (const [, client] of this.clients) {
				if (client.fft && client.fft.open) {
					if (client.fft.dataChannel) {
						const buffered: number = client.fft.dataChannel.bufferedAmount;
						if (buffered > 2097152) client.fftOverflow = true;
						else if (buffered < 524288) client.fftOverflow = false;
						if (client.fftOverflow) continue;
					}
					Promise.resolve(client.fft.send(buf)).catch((error: unknown) => console.error(error));
				}
			}
		} else {
			if (this.connFft && this.connFft.open) {
				if (this.connFft.dataChannel) {
					const buffered: number = this.connFft.dataChannel.bufferedAmount;
					if (buffered > 2097152) this.connFftOverflow = true;
					else if (buffered < 524288) this.connFftOverflow = false;
					if (this.connFftOverflow) return;
				}
				Promise.resolve(this.connFft.send(this._toArrayBuffer(chunk))).catch((error: unknown) => console.error(error));
			}
		}
	}

	sendAudioChunk(chunk: ArrayBuffer | ArrayBufferView): void {
		// Client-side only (client doesn't send audio)
		if (this.connAudio && this.connAudio.open) {
			if (this.connAudio.dataChannel) {
				const buffered: number = this.connAudio.dataChannel.bufferedAmount;
				if (buffered > 1048576) this.connAudioOverflow = true;
				else if (buffered < 262144) this.connAudioOverflow = false;
				if (this.connAudioOverflow) return;
			}
			Promise.resolve(this.connAudio.send(this._toArrayBuffer(chunk))).catch((error: unknown) => console.error(error));
		}
	}

	sendAudioChunkTo(clientId: string, chunk: ArrayBuffer | ArrayBufferView): void {
		const client = this.clients.get(clientId);
		if (!client || !client.audio || !client.audio.open) return;
		if (client.audio.dataChannel) {
			const buffered: number = client.audio.dataChannel.bufferedAmount;
			if (buffered > 1048576) client.audioOverflow = true;
			else if (buffered < 262144) client.audioOverflow = false;
			if (client.audioOverflow) return;
		}
		Promise.resolve(client.audio.send(this._toArrayBuffer(chunk))).catch((error: unknown) => console.error(error));
	}

	// -- Client management (host) --

	kickClient(clientId: string): void {
		this._cleanupClient(clientId);
	}

	getConnectedClientIds(): string[] {
		return Array.from(this.clients.keys());
	}

	close(): void {
		if (this.isHost) {
			for (const [, client] of this.clients) {
				if (client.cmd)
					try {
						client.cmd.close();
					} catch (_) {
						/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
					}
				if (client.fft)
					try {
						client.fft.close();
					} catch (_) {
						/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
					}
				if (client.audio)
					try {
						client.audio.close();
					} catch (_) {
						/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
					}
			}
			this.clients.clear();
		} else {
			if (this.connCmd) this.connCmd.close();
			if (this.connFft) this.connFft.close();
			if (this.connAudio) this.connAudio.close();
		}
		if (this.peer) this.peer.destroy();
	}
}
