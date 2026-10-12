import { isRecord } from '@/platform/data';
import { packAudio } from '@/audio/pcm';
import type { HostStats } from '@/worker/runtime/callbacks.types';
import type { ReceiverCommand, StatusMessage } from '@/remote/types';
import type { AppInstance } from '@/app/core/receiver.types';
import * as Comlink from 'comlink';
import { WebRTCHandler, PEER_ID_PREFIX } from '@/remote/webrtc';

export const remoteMethods = {
	applySharedChannelization(this: AppInstance) {
		if (this.remoteMode === 'client') {
			this._webrtc?.sendCommand({ type: 'clientDisplay', sharedChannelization: this.display.sharedChannelization });
		} else if (this.backend) {
			this.backend.setSharedChannelization(this.display.sharedChannelization).catch(console.error);
		}
	},
	async startRemoteHost(this: AppInstance) {
		if (this.workspace && !this._receiverTransport) return this.workspace.startSharing();
		console.log('[WebRTC] startRemoteHost clicked');
		if (!this.connected || (!this.running && !this._receiverTransport)) {
			console.log('[WebRTC] Device not connected or running');
			this.showMsg('Start the device first to share it.');
			return;
		}
		console.log('[WebRTC] Setting up Host Mode. Mode =', this.remoteMode);
		this.remoteMode = 'host';
		this.locks.centerFreq = true;
		this.locks.sampleRate = true;
		// Lock all gain controls
		if (this.deviceCapabilities) {
			for (const gc of this.deviceCapabilities.gainControls) {
				this.locks[gc.name] = true;
			}
		}
		this.remoteStatus = 'Generating ID...';

		console.log('[WebRTC] Instantiating WebRTCHandler');
		const savedCode = localStorage.getItem('browsdr-share-code');
		this._webrtc = this._receiverTransport || new WebRTCHandler(true, null, savedCode);

		this._webrtc.onStatusChange = (status: StatusMessage) => {
			console.log('[WebRTC] Host status changed:', status);
			if (status.status === 'ready') {
				this.remoteStatus = 'Waiting for connection';
				const origin = window.location.origin;
				const shortId = status.id.replace(PEER_ID_PREFIX, '');
				localStorage.setItem('browsdr-share-code', shortId);
				this.remoteLink = `${origin}/?connect=${shortId}`;
				console.log('[WebRTC] Link completely generated:', this.remoteLink);
			} else if (status.status === 'client-connected') {
				const clientId = status.clientId;
				this.remoteClients.push({
					id: clientId,
					connectedAt: Date.now(),
					country: '',
					vfoCount: 1,
					firstFreq: null,
					isRelay: !!status.isRelay,
				});
				this.remoteStatus = this.remoteClients.length + ' client' + (this.remoteClients.length !== 1 ? 's' : '') + ' connected';
				this.showMsg('Remote client joined!');
				// Register client in worker and sync current state
				Promise.resolve(this.backend.addRemoteClient(clientId)).catch((error: unknown) => console.error(error));
				this._webrtc?.sendCommandTo(clientId, {
					type: 'sync',
					radio: this.radio,
					gains: this.gains,
					locks: this.locks,
					capabilities: this.deviceCapabilities,
				});
			} else if (status.status === 'client-disconnected') {
				const clientId = status.clientId;
				this.remoteClients = this.remoteClients.filter((c) => c.id !== clientId);
				Promise.resolve(this.backend.removeRemoteClient(clientId)).catch((error: unknown) => console.error(error));
				if (this.remoteClients.length > 0) {
					this.remoteStatus = this.remoteClients.length + ' client' + (this.remoteClients.length !== 1 ? 's' : '') + ' connected';
				} else {
					this.remoteStatus = 'Waiting for connection';
				}
				this.showMsg('Remote client left.');
			} else if (status.status === 'error') {
				this.remoteMode = 'none';
				this.showMsg('WebRTC Error: ' + status.error);
			}
		};

		this._webrtc.onCommand = (clientId: string, cmd: ReceiverCommand) => this.handleRemoteCommand(clientId, cmd);

		console.log('[WebRTC] Calling _webrtc.init()');
		if (!this._receiverTransport) await (this._webrtc instanceof WebRTCHandler ? this._webrtc.init() : Promise.resolve(false));
		console.log('[WebRTC] _webrtc.init() finished. Resolving remote host callback.');
		// Setup worker to push FFT arrays via Comlink callback.
		// KiwiSDR-style compression: downsample to WF_REMOTE_BINS and quantize
		// each bin's dB value to a uint8 (1 dB/step, WF_DB_MIN offset).
		// This reduces bandwidth from ~5 MB/s (65536 Float32 @ 20fps) to
		// ~40 KB/s (2048 uint8 @ 20fps) — a ~128× reduction that prevents the
		// DataChannel from saturating and the waterfall from freezing.
		await installHostStreamCallbacks.call(this);
	},
	async connectRemoteClient(this: AppInstance, hostId: string) {
		if (this.workspace && !this._receiverTransport) return this.workspace.connectRemote(hostId);
		this._initAudioCtx(); // create AudioContext within user gesture before any await
		this.remoteMode = 'client';
		this.dspStats = null;
		this.remoteStatus = 'Connecting...';
		this.showMsg('Connecting to remote host...');

		// If this is a valid ID (it connected), it will be added to recents here or earlier.
		// Handled via the UI (connectToRemoteId method).

		this._webrtc = this._receiverTransport || new WebRTCHandler(false, PEER_ID_PREFIX + hostId);

		this._webrtc.onStatusChange = (status: StatusMessage) => {
			Promise.resolve(
				(async (status: StatusMessage) => {
					if (status.status === 'connecting') {
						this.remoteStatus = 'Connecting...';
					} else if (status.status === 'connected') {
						this.remoteStatus = 'Connected to Host';
						this.connected = true;
						this.applySharedChannelization();
						this.info.boardName = 'Remote SDR';
						this.showMsg('Connected to remote host.');

						// Update recent ids list (keep last 5)
						this.recentRemoteIds = this.recentRemoteIds.filter((x: string) => x !== hostId);
						this.recentRemoteIds.unshift(hostId);
						if (this.recentRemoteIds.length > 5) {
							this.recentRemoteIds = this.recentRemoteIds.slice(0, 5);
						}
						this.saveSetting();

						// Start local processing stream using mock device hooked up to WebRTC
						await this.startStream();
						if (this._receiverTransport) return; // Workspace sends client identity once per connection.

						// Send country info + persistent device ID to host so it can
						// detect reconnections from the same device and kick stale peers.
						let deviceId = localStorage.getItem('browsdr-device-id');
						if (!deviceId) {
							try {
								deviceId = crypto.randomUUID();
							} catch (_) {
								deviceId = Math.random().toString(36).substring(2) + Date.now().toString(36);
							}
							localStorage.setItem('browsdr-device-id', deviceId);
						}
						fetch('/api/geo')
							.then((r: Response) => r.json())
							.then((data: unknown) => {
								if (this._webrtc)
									this._webrtc?.sendCommand({
										type: 'clientInfo',
										country: isRecord(data) && typeof data.country === 'string' ? data.country : 'XX',
										deviceId,
									});
							})
							.catch(() => {
								if (this._webrtc) this._webrtc?.sendCommand({ type: 'clientInfo', country: 'XX', deviceId });
							});
					} else if (status.status === 'disconnected') {
						this.remoteStatus = 'Disconnected from Host';
						Promise.resolve(this.disconnect()).catch((error: unknown) => console.error(error));
					} else if (status.status === 'error') {
						this.remoteMode = 'none';
						this.showMsg('WebRTC Error: ' + status.error);
					}
				})(status),
			).catch((error: unknown) => console.error(error));
		};

		this._webrtc.onCommand = (cmd: ReceiverCommand) => this.handleRemoteCommand(cmd);
		this._webrtc.onFftChunk = (chunk) => {
			// Guard on _fftCtx (canvas ready) rather than this.running.
			// this.running is set only after `await backend.startRxStream()` resolves,
			// so frames that arrive in that async gap were silently dropped.
			if (!this._fftCtx) return;
			// chunk arrives as ArrayBuffer (PeerJS serialization:'raw').
			// Guard against Uint8Array in case of fallback path: extract the true
			// underlying bytes via byteOffset + byteLength, not numeric element cast.
			const buf = chunk;
			const u8 = new Uint8Array(buf);
			let fftData: Float32Array;
			if (u8.length >= 4 && u8[0] === 0xff && u8[1] === 0xda) {
				// KiwiSDR-style quantized packet: 4-byte header + N uint8 bins.
				// Unpack: uint8 → Float32 dB using WF_DB_MIN + uint8 value (1 dB/step).
				const WF_DB_MIN = -120.0;
				const binCount = u8[2] | (u8[3] << 8);
				fftData = new Float32Array(binCount);
				for (let i = 0; i < binCount; i++) {
					fftData[i] = WF_DB_MIN + u8[4 + i];
				}
			} else {
				// Legacy fallback: raw Float32 (old host)
				fftData = new Float32Array(buf);
			}
			if (fftData.length > 0) this.drawSpectrum(fftData);
		};
		this._webrtc.onAudioChunk = (chunk) => {
			if (this.running && this.backend) {
				// chunk arrives as ArrayBuffer (serialization:'raw').
				// Use .slice() with byteOffset/byteLength to handle typed-array views.
				const buf = chunk;
				Promise.resolve(this.backend.feedRemoteAudioChunk(Comlink.transfer(buf, [buf]))).catch((error: unknown) => console.error(error));
			}
		};

		try {
			// initRemoteClient MUST come first — it installs the mock hackrf stub.
			// _webrtc.init() may fire the 'connected' event synchronously, which calls
			// startStream() -> startRxStream() -> hackrf.setSampleRateManual(). If the
			// mock isn't in place yet, hackrf is null and the call throws, leaving
			// this.running = false forever (all FFT frames get dropped).
			await this.backend.initRemoteClient();
			if (this._receiverTransport) this._webrtc.onStatusChange({ status: 'connected' });
			else if (this._webrtc instanceof WebRTCHandler) await this._webrtc.init();
		} catch (_e) {
			this.showMsg('Failed to initialize remote client.');
		}
	},
	async regenerateShareCode(this: AppInstance) {
		if (this.workspace) return this.workspace.regenerateShareCode();
		if (this.remoteMode !== 'host' || !this._webrtc) return;
		// Tear down current host session and restart with a fresh code
		localStorage.removeItem('browsdr-share-code');
		this._webrtc.close();
		this._webrtc = null;
		this.remoteLink = '';
		this.remoteClients = [];
		await this.startRemoteHost();
	},
	async connectToRemoteId(this: AppInstance, id: string) {
		const cleanId = id.replace(/https?:\/\/.*?\/\?connect=/, '').trim();
		if (!cleanId) return;

		this.showRemoteConnectDialog = false;

		await this.connectRemoteClient(cleanId);
	},
	removeRecentRemoteId(this: AppInstance, id: string) {
		this.recentRemoteIds = this.recentRemoteIds.filter((x: string) => x !== id);
		this.saveSetting();
	},
	handleRemoteCommand(this: AppInstance, clientIdOrCmd: string | ReceiverCommand, cmdOrUndefined?: ReceiverCommand) {
		// Support both (clientId, cmd) from host and (cmd) from client
		let clientId: string | null, cmd: ReceiverCommand;
		if (cmdOrUndefined === undefined) {
			if (typeof clientIdOrCmd === 'string') return;
			cmd = clientIdOrCmd;
			clientId = null;
		} else {
			if (typeof clientIdOrCmd !== 'string') return;
			clientId = clientIdOrCmd;
			cmd = cmdOrUndefined;
		}

		if (handlePacketTelemetry.call(this, cmd)) return;
		switch (cmd.type) {
			case 'sync':
				handleSync.call(this, cmd, clientId);
				break;
			case 'clientInfo':
				handleClientInfo.call(this, cmd, clientId);
				break;
			case 'dspStats':
				handleDspStats.call(this, cmd, clientId);
				break;
			case 'clientDisplay':
				handleClientDisplay.call(this, cmd, clientId);
				break;
			case 'vfoUpdate':
				handleVfoUpdate.call(this, cmd, clientId);
				break;
			case 'resetRemoteVfos':
				handleResetRemoteVfos.call(this, cmd, clientId);
				break;
			case 'addRemoteVfo':
				handleAddRemoteVfo.call(this, cmd, clientId);
				break;
			case 'removeRemoteVfo':
				handleRemoveRemoteVfo.call(this, cmd, clientId);
				break;
			case 'adsb':
				handleAdsb.call(this, cmd);
				break;
			case 'rtl433':
				handleRtl433.call(this, cmd, clientId);
				break;
			case 'pocsag':
				handlePocsag.call(this, cmd, clientId);
				break;
			case 'rds':
				handleRds.call(this, cmd, clientId);
				break;
			case 'squelchState':
				handleSquelchState.call(this, cmd, clientId);
				break;
			case 'requestChange':
				handleRequestChange.call(this, cmd, clientId);
				break;
		}
	},
	kickRemoteClient(this: AppInstance, clientId: string) {
		if (!this._webrtc) return;
		this._webrtc.kickClient(clientId);
		Promise.resolve(this.backend.removeRemoteClient(clientId)).catch((error: unknown) => console.error(error));
		this.remoteClients = this.remoteClients.filter((c) => c.id !== clientId);
		if (this.remoteClients.length > 0) {
			this.remoteStatus = this.remoteClients.length + ' client' + (this.remoteClients.length !== 1 ? 's' : '') + ' connected';
		} else {
			this.remoteStatus = 'Waiting for connection';
		}
		this.showMsg('Client kicked.');
	},
	remoteClientDuration(this: AppInstance, connectedAt: number) {
		const seconds = Math.floor((Date.now() - connectedAt) / 1000);
		if (seconds < 60) return seconds + 's';
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return minutes + 'm';
		const hours = Math.floor(minutes / 60);
		return hours + 'h ' + (minutes % 60) + 'm';
	},
};

async function installHostStreamCallbacks(this: AppInstance) {
	const WF_REMOTE_BINS = 2048;
	const WF_DB_MIN = -120.0; // uint8 0 ↔ -120 dBfs, 1 dB per LSB
	await this.backend.setRemoteHostFftCallback(
		Comlink.proxy((chunk: Float32Array) => {
			if (!this._webrtc) return;
			const bins = WF_REMOTE_BINS;
			const factor = chunk.length / bins;
			// 4-byte header: 0xFF 0xDA (magic) + uint16-LE bin count
			const pkt = new Uint8Array(4 + bins);
			pkt[0] = 0xff;
			pkt[1] = 0xda;
			pkt[2] = bins & 0xff;
			pkt[3] = (bins >> 8) & 0xff;
			for (let i = 0; i < bins; i++) {
				// Max-hold downsample (same as local waterfall renderSize path)
				let maxVal = -1e9;
				const s = Math.floor(i * factor);
				const e = Math.floor((i + 1) * factor);
				for (let j = s; j < e; j++) {
					if (chunk[j] > maxVal) maxVal = chunk[j];
				}
				// Clamp to [0..255]: 0 = WF_DB_MIN (-120 dB), 255 = -120+255 = +135 dB
				pkt[4 + i] = Math.max(0, Math.min(255, Math.round(maxVal - WF_DB_MIN)));
			}
			this._webrtc.sendFftChunk(pkt);
		}),
	);
	// Setup worker to push processed Audio buffer callbacks (per-client)
	await this.backend.setRemoteHostAudioCallback(
		Comlink.proxy((clientId: string, chunk: Float32Array, channels: 1 | 2 = 1) => {
			if (this._webrtc) {
				this._webrtc.sendAudioChunkTo(clientId, packAudio(chunk, channels));
			}
		}),
	);
	await this.backend.setRemoteHostStatsCallback(
		Comlink.proxy((clientId: string, stats: HostStats) => {
			this._webrtc?.sendCommandTo(clientId, { type: 'dspStats', stats });
		}),
	);
	// Setup POCSAG message callback — forward decoded messages to the specific remote client
	await this.backend.setRemoteHostPocsagCallback(
		Comlink.proxy((clientId: string, vfoIndex: number, freq: number, msg: Parameters<AppInstance['_onPocsagMessage']>[2]) => {
			if (this._webrtc) {
				this._webrtc?.sendCommandTo(clientId, { type: 'pocsag', vfoIndex, freq, msg });
			}
		}),
	);
	// RDS is decoded from MPX on the host; the client receives metadata
	// over the command channel because streamed audio excludes 57 kHz RDS.
	await this.backend.setRemoteHostRdsCallback(
		Comlink.proxy((clientId: string, vfoIndex: number, freq: number, msg: Parameters<AppInstance['_onRdsMessage']>[2]) => {
			if (this._webrtc) {
				this._webrtc?.sendCommandTo(clientId, { type: 'rds', vfoIndex, freq, msg });
			}
		}),
	);
	await this.backend.setRemoteHostRtl433Callback(
		Comlink.proxy((clientId: string, vfoIndex: number, freq: number, msg: Parameters<AppInstance['_onRtl433Message']>[2]) => {
			this._webrtc?.sendCommandTo(clientId, { type: 'rtl433', vfoIndex, freq, msg });
		}),
	);
	await this.backend.setRemoteHostBleCallback(
		Comlink.proxy((clientId: string, index: number, freq: number, msg: Parameters<AppInstance['_onBleMessage']>[2]) => {
			this._webrtc?.sendCommandTo(clientId, { type: 'ble', vfoIndex: index, freq, msg });
		}),
	);
	await this.backend.setRemoteHostAisCallback(
		Comlink.proxy((clientId: string, index: number, freq: number, msg: Parameters<AppInstance['_onAisMessage']>[2]) => {
			this._webrtc?.sendCommandTo(clientId, { type: 'ais', vfoIndex: index, freq, msg });
		}),
	);
	await this.backend.setRemoteHostAcarsCallback(
		Comlink.proxy((clientId: string, index: number, freq: number, msg: Parameters<AppInstance['_onAcarsMessage']>[2]) => {
			this._webrtc?.sendCommandTo(clientId, { type: 'acars', vfoIndex: index, freq, msg });
		}),
	);
	await this.backend.setRemoteHostAdsbCallback(
		Comlink.proxy((clientId: string, index: number, freq: number, msg: Parameters<AppInstance['_onAdsbMessage']>[2]) => {
			this._webrtc?.sendCommandTo(clientId, { type: 'adsb', vfoIndex: index, freq, msg });
		}),
	);
	// Forward squelch state changes so remote clients can track frequency activity
	await this.backend.setRemoteHostSquelchCallback(
		Comlink.proxy((clientId: string, squelchOpen: boolean[]) => {
			if (this._webrtc) {
				this._webrtc?.sendCommandTo(clientId, { type: 'squelchState', squelchOpen });
			}
		}),
	);
}

function handleSync(this: AppInstance, cmd: Extract<ReceiverCommand, { type: 'sync' }>, _clientId: string | null) {
	if (this.remoteMode !== 'client') return;
	this._applyingSync = true;
	if (cmd.capabilities) this.deviceCapabilities = cmd.capabilities;
	if (cmd.radio) {
		// Flush stale audio to prevent glitches when sample rate or center freq changes
		this._resetAudioPlayback();
		Object.assign(this.radio, cmd.radio);
	}
	if (cmd.gains) Object.assign(this.gains, cmd.gains);
	if (cmd.locks) Object.assign(this.locks, cmd.locks);
	Promise.resolve(
		this.$nextTick(() => {
			this._applyingSync = false;
		}),
	).catch((error: unknown) => console.error(error));
}

function handleClientInfo(this: AppInstance, cmd: Extract<ReceiverCommand, { type: 'clientInfo' }>, clientId: string | null) {
	if (this.remoteMode === 'host' && clientId) {
		const rc = this.remoteClients.find((c) => c.id === clientId);
		if (rc) {
			rc.country = cmd.country || 'XX';
			// Detect reconnection from same device: if another client
			// already has this deviceId, kick the stale one.
			if (cmd.deviceId) {
				rc.deviceId = cmd.deviceId;
				const stale = this.remoteClients.find((c) => c.deviceId === cmd.deviceId && c.id !== clientId);
				if (stale) {
					console.log(`[WebRTC] Device ${cmd.deviceId.substring(0, 8)} reconnected, kicking stale peer ${stale.id.substring(0, 8)}`);
					this.kickRemoteClient(stale.id);
				}
			}
		}
	}
}

function handleDspStats(this: AppInstance, cmd: Extract<ReceiverCommand, { type: 'dspStats' }>, _clientId: string | null) {
	if (this.remoteMode === 'client' && cmd.stats && typeof cmd.stats === 'object') this.dspStats = cmd.stats;
}

function handleClientDisplay(this: AppInstance, cmd: Extract<ReceiverCommand, { type: 'clientDisplay' }>, clientId: string | null) {
	if (this.remoteMode === 'host' && clientId && typeof cmd.sharedChannelization === 'boolean') {
		Promise.resolve(this.backend.setRemoteSharedChannelization(clientId, cmd.sharedChannelization)).catch((error: unknown) =>
			console.error(error),
		);
	}
}

function handleVfoUpdate(this: AppInstance, cmd: Extract<ReceiverCommand, { type: 'vfoUpdate' }>, clientId: string | null) {
	if (this.remoteMode === 'host' && clientId) {
		this.backend
			.setRemoteVfoParams(clientId, cmd.index, cmd.params)
			.then((accepted) => {
				if (accepted && cmd.index === 0) {
					const rc = this.remoteClients.find((c) => c.id === clientId);
					if (rc) rc.firstFreq = cmd.params.freq;
				}
			})
			.catch((error: unknown) => console.error(error));
	}
}

function handleResetRemoteVfos(this: AppInstance, cmd: Extract<ReceiverCommand, { type: 'resetRemoteVfos' }>, clientId: string | null) {
	if (this.remoteMode === 'host' && clientId) {
		Promise.resolve(this.backend.removeRemoteClient(clientId)).catch((error: unknown) => console.error(error));
		Promise.resolve(this.backend.addRemoteClient(clientId)).catch((error: unknown) => console.error(error));
		const rc = this.remoteClients.find((c) => c.id === clientId);
		if (rc) rc.vfoCount = 1;
	}
}

function handleAddRemoteVfo(this: AppInstance, cmd: Extract<ReceiverCommand, { type: 'addRemoteVfo' }>, clientId: string | null) {
	if (this.remoteMode === 'host' && clientId) {
		Promise.resolve(this.backend.addRemoteVfo(clientId)).catch((error: unknown) => console.error(error));
		const rc = this.remoteClients.find((c) => c.id === clientId);
		if (rc) rc.vfoCount++;
	}
}

function handleRemoveRemoteVfo(this: AppInstance, cmd: Extract<ReceiverCommand, { type: 'removeRemoteVfo' }>, clientId: string | null) {
	if (this.remoteMode === 'host' && clientId) {
		this.backend
			.removeRemoteVfo(clientId, cmd.index)
			.then((removed) => {
				const rc = this.remoteClients.find((c) => c.id === clientId);
				if (removed && rc && rc.vfoCount > 0) rc.vfoCount--;
			})
			.catch((error: unknown) => console.error(error));
	}
}

function handleRtl433(this: AppInstance, cmd: Extract<ReceiverCommand, { type: 'rtl433' }>, _clientId: string | null) {
	if (this.remoteMode === 'client') this._onRtl433Message(cmd.vfoIndex, cmd.freq, cmd.msg);
}

function handlePocsag(this: AppInstance, cmd: Extract<ReceiverCommand, { type: 'pocsag' }>, _clientId: string | null) {
	if (this.remoteMode === 'client') {
		this._onPocsagMessage(cmd.vfoIndex, cmd.freq, cmd.msg);
	}
}

function handleRds(this: AppInstance, cmd: Extract<ReceiverCommand, { type: 'rds' }>, _clientId: string | null) {
	if (this.remoteMode === 'client') {
		const vfo = this.vfos[cmd.vfoIndex];
		if (vfo?.rds && vfo.mode === 'wfm' && vfo.freq === cmd.freq) {
			this._onRdsMessage(cmd.vfoIndex, cmd.freq, cmd.msg);
		}
	}
}

function handleSquelchState(this: AppInstance, cmd: Extract<ReceiverCommand, { type: 'squelchState' }>, _clientId: string | null) {
	if (this.remoteMode === 'client') {
		// Apply host-side squelch states to local VFO state so
		// getDspStats() returns correct values for frequency activity.
		const states: boolean[] = cmd.squelchOpen;
		for (let i = 0; i < states.length; i++) {
			if (!this.vfoSquelchOpen) this.vfoSquelchOpen = [];
			this.vfoSquelchOpen[i] = states[i];
			// Update activity stats directly (mirrors _statsTimer logic)
			if (!this.vfoActivityStats[i]) {
				this.vfoActivityStats[i] = { count: 0, totalMs: 0, squelchOpenSince: null };
			}
			const stat = this.vfoActivityStats[i];
			const now = Date.now();
			if (states[i] && this.vfos[i]?.enabled) {
				if (stat.squelchOpenSince === null) {
					stat.squelchOpenSince = now;
					stat.count++;
				}
			} else {
				if (stat.squelchOpenSince !== null) {
					stat.totalMs += now - stat.squelchOpenSince;
					stat.squelchOpenSince = null;
				}
			}
		}
		this.activityNow = Date.now();
	}
}

function handleRequestChange(this: AppInstance, cmd: Extract<ReceiverCommand, { type: 'requestChange' }>, clientId: string | null) {
	if (this.remoteMode !== 'host' || !validRequestedChange(this, cmd)) return;
	const { target, property, value } = cmd;
	if (this.locks[property]) {
		if (clientId) this._webrtc?.sendCommandTo(clientId, { type: 'sync', radio: this.radio, gains: this.gains });
		return;
	}
	if (target === 'radio' && (property === 'centerFreq' || property === 'sampleRate')) this.radio[property] = value;
	else if (target === 'gains') this.gains[property] = value;
	this._webrtc?.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains });
}
function validRequestedChange(app: AppInstance, cmd: Extract<ReceiverCommand, { type: 'requestChange' }>): boolean {
	const { target, property, value } = cmd;
	if (!Number.isFinite(value)) return false;
	if (target === 'gains') return validRemoteGain(app, property, value);
	if (target !== 'radio') return false;
	if (property === 'centerFreq') return true;
	return property === 'sampleRate' && (app.deviceCapabilities?.sampleRates.includes(value) ?? false);
}

function validRemoteGain(app: AppInstance, property: string, value: number): boolean {
	const control = app.deviceCapabilities?.gainControls.find((gc) => gc.name === property);
	if (!control || value < control.min || value > control.max) return false;
	const steps = (value - control.min) / control.step;
	return Number.isFinite(steps) && Math.abs(steps - Math.round(steps)) <= 1e-9;
}

function handleAis(this: AppInstance, cmd: Extract<ReceiverCommand, { type: 'ais' }>): void {
	if (this.remoteMode === 'client') this._onAisMessage(cmd.vfoIndex, cmd.freq, cmd.msg);
}

function handlePacketTelemetry(this: AppInstance, cmd: ReceiverCommand): boolean {
	if (cmd.type === 'ais') {
		handleAis.call(this, cmd);
		return true;
	}
	if (cmd.type === 'acars') {
		handleAcars.call(this, cmd);
		return true;
	}
	if (cmd.type !== 'ble') return false;
	if (this.remoteMode === 'client') this._onBleMessage(cmd.vfoIndex, cmd.freq, cmd.msg);
	return true;
}

function handleAcars(this: AppInstance, cmd: Extract<ReceiverCommand, { type: 'acars' }>): void {
	if (this.remoteMode === 'client') this._onAcarsMessage(cmd.vfoIndex, cmd.freq, cmd.msg);
}

function handleAdsb(this: AppInstance, cmd: Extract<ReceiverCommand, { type: 'adsb' }>): void {
	if (this.remoteMode === 'client') this._onAdsbMessage(cmd.vfoIndex, cmd.freq, cmd.msg);
}
