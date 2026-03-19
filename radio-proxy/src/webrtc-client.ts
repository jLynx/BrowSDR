import crypto from 'node:crypto';
import type { Config } from './config.js';
import * as log from './logger.js';

// Polyfill WebRTC globals for Node.js before importing PeerJS
async function setupPolyfills(): Promise<void> {
	const wrtc = await import('@roamhq/wrtc');
	(globalThis as any).RTCPeerConnection = wrtc.default.RTCPeerConnection ?? (wrtc as any).RTCPeerConnection;
	(globalThis as any).RTCSessionDescription = wrtc.default.RTCSessionDescription ?? (wrtc as any).RTCSessionDescription;
	(globalThis as any).RTCIceCandidate = wrtc.default.RTCIceCandidate ?? (wrtc as any).RTCIceCandidate;
	(globalThis as any).RTCDataChannel = wrtc.default.RTCDataChannel ?? (wrtc as any).RTCDataChannel;

	// PeerJS may reference browser globals
	if (typeof globalThis.window === 'undefined') {
		(globalThis as any).window = globalThis;
	}
	if (typeof globalThis.navigator === 'undefined') {
		(globalThis as any).navigator = { userAgent: 'node' };
	}
	if (typeof globalThis.document === 'undefined') {
		(globalThis as any).document = {};
	}
}

const PEER_ID_PREFIX = 'browsdr-';

export interface WebRTCClientEvents {
	onConnected: (syncData: any) => void;
	onAudioChunk: (data: ArrayBuffer) => void;
	onDisconnected: () => void;
	onError: (err: Error) => void;
}

export class WebRTCClient {
	private config: Config;
	private events: WebRTCClientEvents;
	private peer: any = null;
	private connCmd: any = null;
	private connFft: any = null;
	private connAudio: any = null;
	private connected = false;
	private destroyed = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectDelay = 2000;
	private deviceId: string;

	constructor(config: Config, events: WebRTCClientEvents) {
		this.config = config;
		this.events = events;
		this.deviceId = crypto.randomUUID();
	}

	async connect(): Promise<void> {
		if (this.destroyed) return;

		await setupPolyfills();

		const iceServers = await this.fetchTurnCredentials();
		await this.createPeerAndConnect(iceServers);
	}

	private async fetchTurnCredentials(): Promise<any[] | null> {
		try {
			const resp = await fetch(`${this.config.websdrUrl}/api/turn`);
			const data = await resp.json() as any;
			if (data.iceServers?.length > 0) {
				log.info('TURN credentials loaded');
				return data.iceServers;
			}
			log.warn('No TURN servers available, using STUN only');
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn('Failed to fetch TURN credentials:', msg);
		}
		return null;
	}

	private async createPeerAndConnect(iceServers: any[] | null): Promise<void> {
		if (this.destroyed) return;

		const { Peer } = await import('peerjs');

		const peerOpts: any = {};
		if (iceServers) {
			peerOpts.config = { iceServers };
		}

		this.peer = new Peer(undefined as any, peerOpts);

		this.peer.on('open', (id: string) => {
			log.info('Peer ID:', id);
			this.openChannels();
		});

		this.peer.on('error', (err: any) => {
			log.error('PeerJS error:', err.type || err.message || err);
			this.events.onError(new Error(err.type || err.message || 'PeerJS error'));
			this.scheduleReconnect();
		});

		this.peer.on('disconnected', () => {
			log.warn('PeerJS signaling disconnected');
			if (!this.destroyed) {
				this.scheduleReconnect();
			}
		});
	}

	private openChannels(): void {
		const hostPeerId = PEER_ID_PREFIX + this.config.hostId;
		log.info(`Connecting to host: ${hostPeerId}`);

		// Match exactly the channel config from webrtc.ts lines 193-199
		this.connCmd = this.peer.connect(hostPeerId, {
			label: 'cmd',
			reliable: true,
			serialization: 'binary',
		});
		this.connFft = this.peer.connect(hostPeerId, {
			label: 'fft',
			reliable: false,
			serialization: 'raw',
		});
		this.connAudio = this.peer.connect(hostPeerId, {
			label: 'audio',
			reliable: false,
			serialization: 'raw',
		});

		this.setupListeners(this.connCmd, 'cmd');
		this.setupListeners(this.connFft, 'fft');
		this.setupListeners(this.connAudio, 'audio');

		// Connection timeout
		setTimeout(() => {
			if (!this.connected && !this.destroyed) {
				log.warn('Connection timeout after 15s — not all channels opened');
				this.scheduleReconnect();
			}
		}, 15000);
	}

	private setupListeners(conn: any, type: string): void {
		conn.on('open', () => {
			log.info(`Channel "${type}" opened`);
			if (
				this.connCmd?.open &&
				this.connFft?.open &&
				this.connAudio?.open &&
				!this.connected
			) {
				this.connected = true;
				this.reconnectDelay = 2000;
				log.info('All channels open — connected to WebSDR host');
			}
		});

		conn.on('data', (data: any) => {
			if (type === 'cmd') {
				this.handleCommand(data);
			} else if (type === 'audio') {
				this.events.onAudioChunk(data);
			}
			// FFT data is ignored
		});

		conn.on('error', (err: any) => {
			log.error(`Channel "${type}" error:`, err);
		});

		conn.on('close', () => {
			log.warn(`Channel "${type}" closed`);
			if (this.connected) {
				this.connected = false;
				this.events.onDisconnected();
				this.scheduleReconnect();
			}
		});
	}

	private handleCommand(cmd: any): void {
		if (!cmd || typeof cmd !== 'object') return;

		if (cmd.type === 'sync') {
			log.info('Received sync from host');
			if (cmd.radio) {
				log.info(`  Center: ${cmd.radio.centerFreq} MHz, Rate: ${cmd.radio.sampleRate}`);
			}

			// Send clientInfo (matches remote.ts lines 148-156)
			this.connCmd.send({
				type: 'clientInfo',
				country: 'XX',
				deviceId: this.deviceId,
			});

			// Send VFO config to start receiving audio
			this.sendVfoUpdate();

			this.events.onConnected(cmd);
		}
		// Other command types (squelchState, pocsag) are ignored
	}

	private sendVfoUpdate(): void {
		const { vfo } = this.config;

		// Match VfoParams interface from worker/types.ts lines 21-33
		const params = {
			freq: vfo.freq,
			mode: vfo.mode,
			enabled: true,
			bandwidth: vfo.bandwidth,
			deEmphasis: vfo.deEmphasis,
			squelchEnabled: vfo.squelchEnabled,
			squelchLevel: vfo.squelchLevel,
			noiseReduction: false,
			stereo: false,
			lowPass: vfo.lowPass,
			highPass: false,
			rds: false,
			rdsRegion: 'eu',
			volume: vfo.volume,
			pocsag: false,
		};

		log.info(`Setting VFO: ${vfo.freq} MHz, ${vfo.mode.toUpperCase()}, BW: ${vfo.bandwidth} Hz`);

		this.connCmd.send({
			type: 'vfoUpdate',
			index: 0,
			params,
		});
	}

	private scheduleReconnect(): void {
		if (this.destroyed || this.reconnectTimer) return;

		log.info(`Reconnecting in ${this.reconnectDelay / 1000}s...`);

		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = null;
			this.cleanup();

			// Increase backoff, max 60s
			this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);

			try {
				const iceServers = await this.fetchTurnCredentials();
				await this.createPeerAndConnect(iceServers);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				log.error('Reconnection failed:', msg);
				this.scheduleReconnect();
			}
		}, this.reconnectDelay);
	}

	private cleanup(): void {
		this.connected = false;
		try { this.connCmd?.close(); } catch (_) {}
		try { this.connFft?.close(); } catch (_) {}
		try { this.connAudio?.close(); } catch (_) {}
		try { this.peer?.destroy(); } catch (_) {}
		this.connCmd = null;
		this.connFft = null;
		this.connAudio = null;
		this.peer = null;
	}

	isConnected(): boolean {
		return this.connected;
	}

	close(): void {
		this.destroyed = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.cleanup();
	}
}
