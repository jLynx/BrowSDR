import { markRaw } from 'vue';
import { WebRTCHandler, PEER_ID_PREFIX } from '../webrtc';
import { ReceiverTransport, unpackReceiverChunk } from '../receiver-transport';
import { usbSettingsKey } from '../usb-device-selection';
import { bookmarkMethods } from './bookmarks';
import { WorkspaceMediaSession } from './media-session';

interface ReceiverEntry {
	id: string;
	label: string;
	settingsKey: string;
	status: string;
	remote?: boolean;
	deviceLabel?: string;
}

export async function syncReceiverAvailability(app: any, running: boolean): Promise<void> {
	// Inventory changes preserve a client's own pause choice. Only resume
	// automatically if the host interrupted an active receiver.
	if (!running && app._hostRunning !== false) {
		app._resumeAfterHostPause = app.running;
		if (app.running) await app.togglePlay();
	} else if (running && app._hostRunning === false && app._resumeAfterHostPause) {
		await app.startStream(true);
	}
	app._hostRunning = running;
}

/** The workspace owns hardware membership and one remote connection. Each view owns its DSP. */
export function createWorkspace(Receiver: any): any {
	let nextId = 1;
	const instances = new Map<string, any>();
	const ready = new Map<string, (app: any) => void>();
	const claims = new Map<USBDevice, string>();
	let transport: WebRTCHandler | null = null;
	let manifestQueue = Promise.resolve();
	let legacyMigrationClaimed = false;
	let mediaSession: WorkspaceMediaSession;

	return {
		components: { Receiver },
		template: `
			<div class="receiver-workspace">
				<nav v-if="receivers.filter(receiver => receiver.status === 'Receiving' || receiver.status === 'Paused').length > 1" class="receiver-tabs" aria-label="SDR receivers">
					<button v-for="receiver in receivers" :key="receiver.id" class="receiver-tab"
						:class="{ active: selectedId === receiver.id }" :aria-pressed="selectedId === receiver.id" @click="selectReceiver(receiver.id)">
						{{ receiver.label }} <small>{{ receiver.status }}</small>
					</button>
					<button class="btn btn-secondary" v-if="mode !== 'client'" @click="addDevice">+ Add SDR</button>
					<button class="btn btn-secondary" v-if="mode === 'host'" @click="stopSharing">Stop Sharing</button>
					<button class="btn btn-secondary" v-if="mode === 'client'" @click="disconnectRemote">Disconnect Remote</button>
				</nav>
				<div v-if="error" class="workspace-message" role="alert">{{ error }}</div>
				<div v-if="mode === 'client' && !receivers.length" class="workspace-message">
					{{ remoteStatus }}
					<button class="btn btn-secondary" @click="disconnectRemote">Disconnect Remote</button>
				</div>
				<Receiver v-for="receiver in receivers" :key="receiver.id" v-show="selectedId === receiver.id"
					:receiver-id="receiver.id" :settings-key="receiver.settingsKey" :workspace="controller" />
			</div>`,
		data() {
			return {
				receivers: [{ id: 'local-1', label: 'Receiver 1', settingsKey: 'SDRSetting', status: 'Disconnected' }] as ReceiverEntry[],
				selectedId: 'local-1', mode: 'none', error: '', remoteStatus: '', shareLink: '',
				controller: null as any,
				bookmarks: [] as any[],
			};
		},
		created(this: any) { bookmarkMethods.loadBookmarks.call(this); this.controller = markRaw(this); },
		mounted(this: any) {
			const disconnected = (event: any) => {
				const id = claims.get(event.device);
				if (id) this.removeReceiver(id);
			};
			(navigator.usb as any)?.addEventListener('disconnect', disconnected);
			this._removeUsbListener = () => (navigator.usb as any)?.removeEventListener('disconnect', disconnected);
			const hostId = new URLSearchParams(window.location.search).get('connect');
			if (hostId) this.connectRemote(hostId);
		},
		beforeUnmount(this: any) { this._removeUsbListener?.(); transport?.close(); mediaSession?.dispose(); },
		methods: {
			updateMediaSession(this: any) {
				mediaSession ??= new WorkspaceMediaSession(() => [...instances.values()], () => instances.get(this.selectedId));
				mediaSession.update();
			},
			registerReceiver(this: any, id: string, app: any) {
				if (app._disposed || !this.receivers.some((entry: ReceiverEntry) => entry.id === id)) { app._backendWorker?.terminate(); return false; }
				instances.set(id, app);
				ready.get(id)?.(app);
				ready.delete(id);
				app.$watch(() => [app.running, app.connected, app.info.boardName], () => {
					const entry = this.receivers.find((item: ReceiverEntry) => item.id === id);
					if (!entry) return;
					entry.status = app.running ? 'Receiving' : app.connected ? 'Paused' : 'Disconnected';
					if (app.info.boardName && !entry.remote) entry.label = entry.deviceLabel || app.info.boardName;
					this.updateMediaSession();
					if (this.mode === 'host') this.broadcastReceivers();
				});
				this.updateMediaSession();
				return true;
			},
			async newReceiver(this: any, entry?: ReceiverEntry) {
				const id = entry?.id || `local-${++nextId}`;
				const promise = new Promise<any>(resolve => ready.set(id, resolve));
				this.receivers.push(entry || { id, label: `Receiver ${nextId}`, settingsKey: `SDRSetting:${id}`, status: 'Disconnected' });
				this.selectedId = id;
				return promise;
			},
			selectReceiver(this: any, id: string) {
				this.selectedId = id;
				this.$nextTick(() => {
					const app = instances.get(id);
					if (app?._fftCtx) app.resizeFftCanvas();
				});
			},
			async addDevice(this: any) {
				const app = instances.get(this.selectedId);
				if (!app) return;
				try { await app.connect(); } catch (error: any) { this.error = error.message; }
			},
			isDeviceConnected(this: any, device: USBDevice) {
				// WebUSB reuses each physical device's object within this window.
				// A serial number alone cannot identify RTL-SDRs with factory serials.
				return claims.has(device);
			},
			async connectDevice(this: any, source: any, device: USBDevice | 'mock') {
				if (this.mode === 'client') return;
				if (source._connectingDevice) return;
				if (device !== 'mock' && this.isDeviceConnected(device)) { source.showMsg('This SDR is already connected.'); return; }
				source._connectingDevice = true;
				if (device !== 'mock') claims.set(device, source.receiverId);
				const app = source.connected ? await this.newReceiver() : source;
				if (!app) {
					if (device !== 'mock') claims.delete(device);
					source._connectingDevice = false;
					return;
				}
				app._connectingDevice = true;
				const entry = this.receivers.find((item: ReceiverEntry) => item.id === app.receiverId);
				if (device !== 'mock') claims.set(device, app.receiverId); // Reserve before any USB awaits.
				let useLegacy = false;
				try {
					if (device !== 'mock') {
						const paired = await navigator.usb.getDevices();
						const index = paired.indexOf(device);
						if (index < 0) throw new Error('SDR is no longer connected');
						entry.settingsKey = usbSettingsKey(device, paired);
						entry.deviceLabel = `SDR ${index + 1} · ${device.productName || 'USB SDR'}`;
						entry.label = entry.deviceLabel;
						await this.$nextTick();
						useLegacy = !legacyMigrationClaimed;
						legacyMigrationClaimed = true;
						app.loadSetting(useLegacy);
						await app._connectToDevice(device, index);
					} else await app._connectMock();
					if (!app.connected) {
						if (useLegacy) legacyMigrationClaimed = false;
						if (device !== 'mock') claims.delete(device);
						return;
					}
					app._initAudioCtx();
					if (this.mode === 'host') await this.attachHostReceiver(app);
					await this.$nextTick();
					this.broadcastReceivers();
				} catch (error: any) {
					if (useLegacy && !app.connected) legacyMigrationClaimed = false;
					if (device !== 'mock') claims.delete(device);
					this.error = error.message;
				} finally {
					source._connectingDevice = false;
					app._connectingDevice = false;
				}
			},
			async removeReceiver(this: any, id: string) {
				const app = instances.get(id);
				if (app?._removing) return;
				if (app) app._removing = true;
				// Remove membership before awaiting teardown so late initialization cannot register.
				instances.delete(id);
				this.updateMediaSession();
				ready.get(id)?.(null);
				ready.delete(id);
				for (const [device, receiverId] of claims) if (receiverId === id) claims.delete(device);
				this.receivers = this.receivers.filter((entry: ReceiverEntry) => entry.id !== id);
				try { await app?._disconnectReceiver(); } catch (error: any) { console.warn('Disconnect receiver:', error); }
				app?._backendWorker?.terminate();
				app?._whisperWorker?.terminate();
				if (this.selectedId === id) this.selectedId = this.receivers[0]?.id || '';
				this.broadcastReceivers();
				if (!this.receivers.length && this.mode !== 'client') {
					await this.stopSharing();
					await this.newReceiver();
				}
				this.selectReceiver(this.selectedId);
			},
			broadcastReceivers(this: any, clientId?: string) {
				if (this.mode !== 'host' || !transport) return;
				const command = { type: 'receivers', receivers: this.receivers.filter((entry: ReceiverEntry) => instances.get(entry.id)?.connected).map((entry: ReceiverEntry) => {
					const app = instances.get(entry.id);
					return { id: entry.id, name: entry.label, running: app.running, radio: { ...app.radio }, gains: { ...app.gains }, locks: { ...app.locks }, capabilities: app.deviceCapabilities };
				}) };
				if (clientId) transport.sendCommandTo(clientId, command);
				else transport.sendCommand(command);
			},
			async attachHostReceiver(this: any, app: any) {
				if (!transport || app._receiverTransport) return;
				app._receiverTransport = markRaw(new ReceiverTransport(app.receiverId, transport, () => this.removeReceiver(app.receiverId)));
				await app.startRemoteHost();
				app.remoteLink = this.shareLink;
				for (const clientId of transport.getConnectedClientIds()) app._webrtc.onStatusChange?.({ status: 'client-connected', clientId });
			},
			async startSharing(this: any) {
				if (this.mode === 'host') return;
				if (![...instances.values()].some(app => app.running && app.connected)) { this.error = 'Start an SDR before sharing.'; return; }
				this.error = '';
				this.mode = 'host';
				transport = markRaw(new WebRTCHandler(true, null, localStorage.getItem('browsdr-share-code')));
				transport.onStatusChange = (status: any) => {
					if (status.status === 'ready') {
						const code = status.id.replace(PEER_ID_PREFIX, '');
						localStorage.setItem('browsdr-share-code', code);
						this.shareLink = `${window.location.origin}/?connect=${code}`;
					}
					if (status.status === 'client-connected') this.broadcastReceivers(status.clientId);
					for (const app of instances.values()) {
						if (!app._receiverTransport) continue;
						app._webrtc.onStatusChange?.(status);
						app.remoteLink = this.shareLink;
					}
					if (status.status === 'error') { this.error = `Sharing error: ${status.error}`; this.stopSharing(); }
				};
				transport.onCommand = (clientId: string, command: any) => {
					const app = instances.get(command.receiverId);
					if (command.type === 'clientInfo') {
						for (const receiver of instances.values()) receiver._webrtc?.onCommand?.(clientId, command);
					} else if (app?._receiverTransport) app._webrtc.onCommand?.(clientId, command);
				};
				try {
					for (const app of instances.values()) if (app.connected) await this.attachHostReceiver(app);
					const result = await transport.init();
					if (!result) throw new Error('PeerJS could not initialize');
				} catch (error: any) { this.error = error.message; await this.stopSharing(); }
			},
			async stopSharing(this: any) {
				if (this.mode !== 'host') return;
				const previous = transport;
				transport = null;
				this.mode = 'none';
				previous?.close();
				for (const app of instances.values()) {
					for (const client of app.remoteClients) await app.backend.removeRemoteClient(client.id);
					app._receiverTransport = app._webrtc = null;
					app.remoteMode = 'none';
					app.remoteClients = [];
					app.remoteLink = '';
				}
				this.shareLink = '';
			},
			async regenerateShareCode(this: any) {
				await this.stopSharing();
				localStorage.removeItem('browsdr-share-code');
				await this.startSharing();
			},
			async connectRemote(this: any, hostId: string) {
				if (this.mode === 'client') return;
				this.error = '';
				await this.stopSharing();
				this.mode = 'client';
				for (const entry of [...this.receivers]) await this.removeReceiver(entry.id);
				this.remoteStatus = 'Connecting to remote host…';
				transport = markRaw(new WebRTCHandler(false, PEER_ID_PREFIX + hostId));
				const connection = transport;
				const enqueue = (operation: () => Promise<void>) => {
					manifestQueue = manifestQueue.then(async () => { if (transport === connection) await operation(); }).catch((error: any) => { this.error = error.message; });
				};
				transport.onCommand = (command: any) => {
					if (command.type === 'receivers') enqueue(() => this.applyReceivers(command.receivers, hostId));
					else enqueue(async () => {
						// Older single-receiver hosts have no inventory or receiver envelope.
						if (!command.receiverId && !this.receivers.length && command.type === 'sync') await this.applyReceivers([{ id: 'legacy', name: 'Remote SDR', running: true, ...command }], hostId);
						const id = command.receiverId || this.receivers[0]?.id;
						instances.get(id)?._webrtc?.onCommand?.(command);
					});
				};
				const routeChunk = (kind: 'onFftChunk' | 'onAudioChunk', chunk: any) => {
					const packet = unpackReceiverChunk(chunk);
					if (!packet || transport !== connection) return;
					const id = packet.receiverId || this.receivers[0]?.id;
					instances.get(id)?._webrtc?.[kind]?.(packet.payload);
				};
				transport.onFftChunk = chunk => routeChunk('onFftChunk', chunk);
				transport.onAudioChunk = chunk => routeChunk('onAudioChunk', chunk);
				transport.onStatusChange = (status: any) => {
					if (transport !== connection) return;
					if (status.status === 'connected') {
						this.remoteStatus = 'Waiting for receivers…';
						let deviceId = localStorage.getItem('browsdr-device-id');
						if (!deviceId) { deviceId = crypto.randomUUID(); localStorage.setItem('browsdr-device-id', deviceId); }
						fetch('/api/geo').then(response => response.json()).then((data: any) => connection.sendCommand({ type: 'clientInfo', country: data.country || 'XX', deviceId })).catch(() => connection.sendCommand({ type: 'clientInfo', country: 'XX', deviceId }));
					}
					if (status.status === 'error' || status.status === 'disconnected') { this.error = status.error || 'Disconnected from host'; this.disconnectRemote(); }
				};
				try { if (!await transport.init()) throw new Error('PeerJS could not initialize'); }
				catch (error: any) { this.error = error.message; await this.disconnectRemote(); }
			},
			async applyReceivers(this: any, inventory: any[], hostId: string) {
				if (!Array.isArray(inventory) || this.mode !== 'client' || !transport) return;
				const valid = inventory.filter(item => typeof item?.id === 'string' && item.id && item.radio);
				const connection = transport;
				const selected = this.selectedId;
				for (const entry of [...this.receivers]) if (!valid.some(item => item.id === entry.id)) await this.removeReceiver(entry.id);
				for (const item of valid) {
					if (transport !== connection || this.mode !== 'client') return;
					let app = instances.get(item.id);
					if (!app) {
						app = await this.newReceiver({ id: item.id, label: item.name || 'Remote SDR', settingsKey: `SDRSetting:remote:${hostId}:${item.id}`, status: 'Connecting', remote: true });
						if (!app || transport !== connection || this.mode !== 'client') return;
						Object.assign(app.radio, item.radio);
						if (app.vfos.length && Math.abs(app.vfos[0].freq - item.radio.centerFreq) > item.radio.sampleRate / 2e6) app.vfos[0].freq = item.radio.centerFreq;
						app._receiverTransport = markRaw(new ReceiverTransport(item.id, transport, () => this.disconnectRemote()));
						await app.connectRemoteClient(hostId);
						if (transport !== connection || this.mode !== 'client') return;
						app.audioUnlockPendingId = hostId;
					}
					const entry = this.receivers.find((entry: ReceiverEntry) => entry.id === item.id);
					if (entry) entry.label = item.name || 'Remote SDR';
					app.handleRemoteCommand({ type: 'sync', radio: item.radio, gains: item.gains, locks: item.locks, capabilities: item.capabilities });
					await syncReceiverAvailability(app, item.running !== false);
				}
				this.selectReceiver(instances.has(selected) ? selected : this.receivers[0]?.id || '');
				this.remoteStatus = this.receivers.length ? 'Connected to host' : 'Host has no connected receivers';
			},
			async disconnectRemote(this: any) {
				if (this.mode !== 'client' || this._disconnecting) return;
				this._disconnecting = true;
				const previous = transport;
				transport = null;
				manifestQueue = Promise.resolve();
				previous?.close();
				for (const entry of [...this.receivers]) await this.removeReceiver(entry.id);
				this.mode = 'none';
				window.history.replaceState({}, document.title, '/');
				await this.newReceiver();
				this._disconnecting = false;
			},
		},
	};
}
