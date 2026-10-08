const workspaceTemplate = `
			<div class="receiver-workspace">
				<nav v-if="receivers.filter(receiver => receiver.status === 'Receiving' || receiver.status === 'Paused').length > 1" class="receiver-tabs" aria-label="SDR receivers">
					<UiButton v-for="receiver in receivers" :key="receiver.id" variant="receiver-tab"
						:class="{ active: selectedId === receiver.id }" :aria-pressed="selectedId === receiver.id" @click="selectReceiver(receiver.id)">
						{{ receiver.label }} <small>{{ receiver.status }}</small>
					</UiButton>
					<UiButton variant="secondary" v-if="mode !== 'client'" @click="addDevice">+ Add SDR</UiButton>
					<UiButton variant="secondary" v-if="mode === 'host'" @click="stopSharing">Stop Sharing</UiButton>
					<UiButton variant="secondary" v-if="mode === 'client'" @click="disconnectRemote">Disconnect Remote</UiButton>
				</nav>
				<div v-if="error" class="workspace-message" role="alert">{{ error }}</div>
				<UiNotice v-if="remoteCapabilityIssue" v-bind="remoteCapabilityIssue" />
				<div v-if="mode === 'client' && !receivers.length" class="workspace-message">
					{{ remoteStatus }}
					<UiButton variant="secondary" @click="disconnectRemote">Disconnect Remote</UiButton>
				</div>
				<Receiver v-for="receiver in receivers" :key="receiver.id" v-show="selectedId === receiver.id"
					:receiver-id="receiver.id" :settings-key="receiver.settingsKey" :workspace="controller" />
			</div>`;
import { isRecord } from '@/platform/data';
import { errorMessage } from '@/platform/errors';
import type { WorkspaceInstance, ReceiverEntry, ReceiverComponent, Bookmark } from './types';
import type { AppInstance } from '@/app/core/receiver.types';
import type { ReceiverCommand, ReceiverInventory } from '@/remote/types';
import { markRaw } from 'vue';
import { WebRTCHandler, PEER_ID_PREFIX } from '@/remote/webrtc';
import { ReceiverTransport, unpackReceiverChunk } from '@/remote/receiver-transport';
import { usbSettingsKey } from '@/radio/usb-device-selection';
import { bookmarkMethods } from './bookmarks';
import { WorkspaceMediaSession } from '@/app/audio/media-session';
import { UiButton, UiNotice } from '@/ui';
import { remoteConnectionIssue } from '@/platform/browser-capabilities';
import type { CapabilityIssue } from '@/platform/types';

export async function syncReceiverAvailability(app: AppInstance, running: boolean): Promise<void> {
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
export function createWorkspace(Receiver: ReceiverComponent) {
	const runtime = new WorkspaceRuntime();
	return {
		components: { Receiver, UiButton, UiNotice },
		template: workspaceTemplate,
		data() {
			return {
				receivers: [{ id: 'local-1', label: 'Receiver 1', settingsKey: 'SDRSetting', status: 'Disconnected' }] as ReceiverEntry[],
				selectedId: 'local-1',
				mode: 'none',
				error: '',
				remoteStatus: '',
				shareLink: '',
				controller: null as WorkspaceInstance | null,
				remoteCapabilityIssue: null as CapabilityIssue | null,
				bookmarks: [] as Bookmark[],
			};
		},
		created(this: WorkspaceInstance) {
			bookmarkMethods.loadBookmarks.call(this);
			this.controller = markRaw(this);
		},
		mounted(this: WorkspaceInstance) {
			const disconnected = (event: Event) => {
				const id = runtime.claims.get((event as USBConnectionEvent).device);
				if (id) Promise.resolve(this.removeReceiver(id)).catch((error: unknown) => console.error(error));
			};
			navigator.usb?.addEventListener('disconnect', disconnected);
			this._removeUsbListener = () => navigator.usb?.removeEventListener('disconnect', disconnected);
			const hostId = new URLSearchParams(window.location.search).get('connect');
			if (hostId) Promise.resolve(this.connectRemote(hostId)).catch((error: unknown) => console.error(error));
		},
		beforeUnmount(this: WorkspaceInstance) {
			this._removeUsbListener?.();
			runtime.transport?.close();
			runtime.mediaSession?.dispose();
		},
		methods: {
			updateMediaSession(this: WorkspaceInstance) {
				return updateMediaSession.call(this, runtime);
			},
			registerReceiver(this: WorkspaceInstance, id: string, app: AppInstance) {
				return registerReceiver.call(this, runtime, id, app);
			},
			newReceiver(this: WorkspaceInstance, entry?: ReceiverEntry) {
				return newReceiver.call(this, runtime, entry);
			},
			selectReceiver(this: WorkspaceInstance, id: string) {
				return selectReceiver.call(this, runtime, id);
			},
			addDevice(this: WorkspaceInstance) {
				return addDevice.call(this, runtime);
			},
			isDeviceConnected(this: WorkspaceInstance, device: USBDevice) {
				return isDeviceConnected.call(this, runtime, device);
			},
			connectDevice(this: WorkspaceInstance, source: AppInstance, device: USBDevice | 'mock') {
				return connectDevice.call(this, runtime, source, device);
			},
			removeReceiver(this: WorkspaceInstance, id: string) {
				return removeReceiver.call(this, runtime, id);
			},
			broadcastReceivers(this: WorkspaceInstance, clientId?: string) {
				return broadcastReceivers.call(this, runtime, clientId);
			},
			attachHostReceiver(this: WorkspaceInstance, app: AppInstance) {
				return attachHostReceiver.call(this, runtime, app);
			},
			startSharing(this: WorkspaceInstance) {
				return startSharing.call(this, runtime);
			},
			stopSharing(this: WorkspaceInstance) {
				return stopSharing.call(this, runtime);
			},
			regenerateShareCode(this: WorkspaceInstance) {
				return regenerateShareCode.call(this, runtime);
			},
			connectRemote(this: WorkspaceInstance, hostId: string) {
				return connectRemote.call(this, runtime, hostId);
			},
			applyReceivers(this: WorkspaceInstance, inventory: ReceiverInventory[], hostId: string) {
				return applyReceivers.call(this, runtime, inventory, hostId);
			},
			disconnectRemote(this: WorkspaceInstance) {
				return disconnectRemote.call(this, runtime);
			},
		},
	};
}

class WorkspaceRuntime {
	nextId = 1;
	instances = new Map<string, AppInstance>();
	ready = new Map<string, (app: AppInstance | null) => void>();
	claims = new Map<USBDevice, string>();
	transport: WebRTCHandler | null = null;
	manifestQueue = Promise.resolve();
	legacyMigrationClaimed = false;
	mediaSession?: WorkspaceMediaSession;
}

function updateMediaSession(this: WorkspaceInstance, runtime: WorkspaceRuntime) {
	runtime.mediaSession ??= new WorkspaceMediaSession(
		() => [...runtime.instances.values()],
		() => runtime.instances.get(this.selectedId),
	);
	runtime.mediaSession.update();
}

function registerReceiver(this: WorkspaceInstance, runtime: WorkspaceRuntime, id: string, app: AppInstance) {
	if (app._disposed || !this.receivers.some((entry: ReceiverEntry) => entry.id === id)) {
		app._backendWorker?.terminate();
		return false;
	}
	runtime.instances.set(id, app);
	runtime.ready.get(id)?.(app);
	runtime.ready.delete(id);
	app.$watch(
		() => [app.running, app.connected, app.info.boardName],
		() => {
			const entry = this.receivers.find((item: ReceiverEntry) => item.id === id);
			if (!entry) return;
			entry.status = app.running ? 'Receiving' : app.connected ? 'Paused' : 'Disconnected';
			if (app.info.boardName && !entry.remote) entry.label = entry.deviceLabel || app.info.boardName;
			this.updateMediaSession();
			if (this.mode === 'host') this.broadcastReceivers();
		},
	);
	this.updateMediaSession();
	return true;
}

async function newReceiver(this: WorkspaceInstance, runtime: WorkspaceRuntime, entry?: ReceiverEntry) {
	const id = entry?.id || `local-${++runtime.nextId}`;
	const promise = new Promise<AppInstance | null>((resolve) => runtime.ready.set(id, resolve));
	this.receivers.push(entry || { id, label: `Receiver ${runtime.nextId}`, settingsKey: `SDRSetting:${id}`, status: 'Disconnected' });
	this.selectedId = id;
	return promise;
}

function selectReceiver(this: WorkspaceInstance, runtime: WorkspaceRuntime, id: string) {
	this.selectedId = id;
	Promise.resolve(
		this.$nextTick(() => {
			const app = runtime.instances.get(id ?? '');
			if (app?._fftCtx) app.resizeFftCanvas();
		}),
	).catch((error: unknown) => console.error(error));
}

async function addDevice(this: WorkspaceInstance, runtime: WorkspaceRuntime) {
	const app = runtime.instances.get(this.selectedId);
	if (!app) return;
	try {
		await app.connect();
	} catch (error) {
		this.error = errorMessage(error);
	}
}

function isDeviceConnected(this: WorkspaceInstance, runtime: WorkspaceRuntime, device: USBDevice) {
	// WebUSB reuses each physical device's object within this window.
	// A serial number alone cannot identify RTL-SDRs with factory serials.
	return runtime.claims.has(device);
}

async function connectDevice(this: WorkspaceInstance, runtime: WorkspaceRuntime, source: AppInstance, device: USBDevice | 'mock') {
	if (this.mode === 'client') return;
	if ([source._connectingDevice, source._removing].some(Boolean)) return;
	if (device !== 'mock' && this.isDeviceConnected(device)) {
		source.showMsg('This SDR is already connected.');
		return;
	}
	source._connectingDevice = true;
	if (device !== 'mock') runtime.claims.set(device, source.receiverId);
	const app = source.connected ? await this.newReceiver() : source;
	if (!app) {
		if (device !== 'mock') runtime.claims.delete(device);
		source._connectingDevice = false;
		return;
	}
	app._connectingDevice = true;
	const entry = this.receivers.find((item: ReceiverEntry) => item.id === app.receiverId);
	if (!entry) return;
	if (device !== 'mock') runtime.claims.set(device, app.receiverId); // Reserve before any USB awaits.
	let useLegacy = false;
	try {
		if (device !== 'mock') {
			let index;
			({ index, useLegacy } = await prepareUsbSettings.call(this, device, entry, useLegacy, runtime, app));
			await app._connectToDevice(device, index);
		} else await app._connectMock();
		if (!app.connected) {
			if (useLegacy) runtime.legacyMigrationClaimed = false;
			if (device !== 'mock') runtime.claims.delete(device);
			return;
		}
		app._initAudioCtx();
		if (this.mode === 'host') await this.attachHostReceiver(app);
		await this.$nextTick();
		this.broadcastReceivers();
	} catch (error) {
		if (useLegacy && !app.connected) runtime.legacyMigrationClaimed = false;
		if (device !== 'mock') runtime.claims.delete(device);
		this.error = errorMessage(error);
	} finally {
		source._connectingDevice = false;
		app._connectingDevice = false;
	}
}

async function prepareUsbSettings(
	this: WorkspaceInstance,
	device: USBDevice,
	entry: ReceiverEntry,
	useLegacy: boolean,
	runtime: WorkspaceRuntime,
	app: AppInstance,
) {
	const paired = await navigator.usb.getDevices();
	const index = paired.indexOf(device);
	if (index < 0) throw new Error('SDR is no longer connected');
	const startupSettings = entry.settingsKey === 'SDRSetting';
	entry.settingsKey = usbSettingsKey(device, paired);
	entry.deviceLabel = `SDR ${index + 1} · ${device.productName || 'USB SDR'}`;
	entry.label = entry.deviceLabel;
	await this.$nextTick();
	useLegacy = !runtime.legacyMigrationClaimed;
	runtime.legacyMigrationClaimed = true;
	// The first local receiver already displays the user's startup configuration.
	// Transfer that configuration to its device key rather than replacing it with
	// an older device save. Additional receivers still restore their own settings.
	if (useLegacy && startupSettings) app.saveSetting();
	else app.loadSetting(useLegacy);
	return { index, useLegacy };
}

async function removeReceiver(this: WorkspaceInstance, runtime: WorkspaceRuntime, id: string) {
	const app = runtime.instances.get(id);
	if (app?._removing) return;
	if (app) app._removing = true;
	// Keep the last local receiver mounted while USB/audio shut down. Recreating
	// it leaves the workspace empty and needlessly initializes another worker.
	if (app && this.mode !== 'client' && this.receivers.length === 1) {
		return disconnectLastLocalReceiver.call(this, runtime, app);
	}
	// Remove membership before awaiting teardown so late initialization cannot register.
	runtime.instances.delete(id);
	this.updateMediaSession();
	runtime.ready.get(id)?.(null);
	runtime.ready.delete(id);
	for (const [device, receiverId] of runtime.claims) if (receiverId === id) runtime.claims.delete(device);
	this.receivers = this.receivers.filter((entry: ReceiverEntry) => entry.id !== id);
	if (this.selectedId === id) this.selectReceiver(this.receivers[0]?.id || '');
	await disposeReceiver(app);
	if (this.selectedId === id) this.selectedId = this.receivers[0]?.id || '';
	this.broadcastReceivers();
	if (!this.receivers.length && this.mode !== 'client') {
		await this.stopSharing();
		await this.newReceiver();
	}
	this.selectReceiver(this.selectedId);
}

async function disposeReceiver(app: AppInstance | undefined) {
	if (!app) return;
	try {
		await app._disconnectReceiver();
	} catch (error) {
		console.warn('Disconnect receiver:', error);
	}
	app._backendWorker?.terminate();
	app._whisperWorker?.terminate();
}

async function disconnectLastLocalReceiver(this: WorkspaceInstance, runtime: WorkspaceRuntime, app: AppInstance) {
	for (const [device, receiverId] of runtime.claims) if (receiverId === app.receiverId) runtime.claims.delete(device);
	try {
		await app._disconnectReceiver();
	} catch (error) {
		console.warn('Disconnect receiver:', error);
	} finally {
		app.connected = false;
		app.running = false;
		app.info.boardName = '';
		app.deviceCapabilities = null;
		const entry = this.receivers[0];
		entry.status = 'Disconnected';
		entry.label = 'Receiver';
		entry.deviceLabel = undefined;
		app._removing = false;
		this.updateMediaSession();
	}
	this.broadcastReceivers();
	await this.stopSharing();
}

function broadcastReceivers(this: WorkspaceInstance, runtime: WorkspaceRuntime, clientId?: string) {
	if (this.mode !== 'host' || !runtime.transport) return;
	const command: ReceiverCommand = {
		type: 'receivers',
		receivers: this.receivers
			.filter((entry: ReceiverEntry) => runtime.instances.get(entry.id)?.connected)
			.map((entry: ReceiverEntry) => {
				const app = runtime.instances.get(entry.id)!;
				return {
					id: entry.id,
					name: entry.label,
					running: app.running,
					radio: { ...app.radio },
					gains: { ...app.gains },
					locks: { ...app.locks },
					capabilities: app.deviceCapabilities,
				};
			}),
	};
	if (clientId) runtime.transport.sendCommandTo(clientId, command);
	else runtime.transport.sendCommand(command);
}

async function attachHostReceiver(this: WorkspaceInstance, runtime: WorkspaceRuntime, app: AppInstance) {
	if (!runtime.transport || app._receiverTransport) return;
	app._receiverTransport = markRaw(
		new ReceiverTransport(app.receiverId, runtime.transport, () => {
			Promise.resolve((() => this.removeReceiver(app.receiverId))()).catch((error: unknown) => console.error(error));
		}),
	);
	await app.startRemoteHost();
	app.remoteLink = this.shareLink;
	for (const clientId of runtime.transport.getConnectedClientIds()) app._webrtc?.onStatusChange?.({ status: 'client-connected', clientId });
}

async function startSharing(this: WorkspaceInstance, runtime: WorkspaceRuntime) {
	if (this.mode === 'host') return;
	this.remoteCapabilityIssue = remoteConnectionIssue();
	if (this.remoteCapabilityIssue) return;
	if (![...runtime.instances.values()].some((app) => app.running && app.connected)) {
		this.error = 'Start an SDR before sharing.';
		return;
	}
	this.error = '';
	this.mode = 'host';
	runtime.transport = markRaw(new WebRTCHandler(true, null, localStorage.getItem('browsdr-share-code')));
	runtime.transport.onStatusChange = (status) => {
		if (status.status === 'ready') {
			const code = status.id.replace(PEER_ID_PREFIX, '');
			localStorage.setItem('browsdr-share-code', code);
			this.shareLink = `${window.location.origin}/?connect=${code}`;
		}
		if (status.status === 'client-connected') this.broadcastReceivers(status.clientId);
		for (const app of runtime.instances.values()) {
			if (!app._receiverTransport) continue;
			app._webrtc?.onStatusChange?.(status);
			app.remoteLink = this.shareLink;
		}
		if (status.status === 'error') {
			this.error = `Sharing error: ${status.error}`;
			Promise.resolve(this.stopSharing()).catch((error: unknown) => console.error(error));
		}
	};
	runtime.transport.onCommand = (clientId: string, command: ReceiverCommand) => {
		const app = runtime.instances.get(command.receiverId ?? '');
		if (command.type === 'clientInfo') {
			for (const receiver of runtime.instances.values()) receiver._webrtc?.receiveHostCommand(clientId, command);
		} else if (app?._receiverTransport) app._webrtc?.receiveHostCommand(clientId, command);
	};
	try {
		for (const app of runtime.instances.values()) if (app.connected) await this.attachHostReceiver(app);
		const result = await runtime.transport.init();
		if (!result) throw new Error('PeerJS could not initialize');
	} catch (error) {
		this.error = errorMessage(error);
		await this.stopSharing();
	}
}

async function stopSharing(this: WorkspaceInstance, runtime: WorkspaceRuntime) {
	if (this.mode !== 'host') return;
	const previous = runtime.transport;
	runtime.transport = null;
	this.mode = 'none';
	previous?.close();
	for (const app of runtime.instances.values()) {
		for (const client of app.remoteClients) await app.backend.removeRemoteClient(client.id);
		app._receiverTransport = app._webrtc = null;
		app.remoteMode = 'none';
		app.remoteClients = [];
		app.remoteLink = '';
	}
	this.shareLink = '';
}

async function regenerateShareCode(this: WorkspaceInstance, _runtime: WorkspaceRuntime) {
	await this.stopSharing();
	localStorage.removeItem('browsdr-share-code');
	await this.startSharing();
}

async function connectRemote(this: WorkspaceInstance, runtime: WorkspaceRuntime, hostId: string) {
	if (this.mode === 'client') return;
	this.remoteCapabilityIssue = remoteConnectionIssue();
	if (this.remoteCapabilityIssue) return;
	this.error = '';
	await this.stopSharing();
	this.mode = 'client';
	for (const entry of [...this.receivers]) await this.removeReceiver(entry.id);
	this.remoteStatus = 'Connecting to remote host…';
	runtime.transport = markRaw(new WebRTCHandler(false, PEER_ID_PREFIX + hostId));
	const connection = runtime.transport;
	const enqueue = (operation: () => Promise<void>) => {
		runtime.manifestQueue = runtime.manifestQueue
			.then(async () => {
				if (runtime.transport === connection) await operation();
			})
			.catch((error) => {
				this.error = errorMessage(error);
			});
	};
	runtime.transport.onCommand = (command: ReceiverCommand) => {
		if (command.type === 'receivers') enqueue(() => this.applyReceivers(command.receivers, hostId));
		else
			enqueue(async () => {
				// Older single-receiver hosts have no inventory or receiver envelope.
				if (!command.receiverId && !this.receivers.length && command.type === 'sync' && command.radio)
					await this.applyReceivers(
						[
							{
								id: 'legacy',
								name: 'Remote SDR',
								running: true,
								radio: command.radio,
								gains: command.gains ?? {},
								locks: command.locks ?? {},
								capabilities: command.capabilities ?? null,
							},
						],
						hostId,
					);
				const id = command.receiverId || this.receivers[0]?.id;
				runtime.instances.get(id)?._webrtc?.receiveClientCommand(command);
			});
	};
	const routeChunk = (kind: 'onFftChunk' | 'onAudioChunk', chunk: ArrayBuffer) => {
		const packet = unpackReceiverChunk(chunk);
		if (!packet || runtime.transport !== connection) return;
		const id = packet.receiverId || this.receivers[0]?.id;
		runtime.instances.get(id)?._webrtc?.[kind]?.(packet.payload);
	};
	runtime.transport.onFftChunk = (chunk) => routeChunk('onFftChunk', chunk);
	runtime.transport.onAudioChunk = (chunk) => routeChunk('onAudioChunk', chunk);
	runtime.transport.onStatusChange = (status) => {
		if (runtime.transport !== connection) return;
		if (status.status === 'connected') {
			this.remoteStatus = 'Waiting for receivers…';
			let deviceId = localStorage.getItem('browsdr-device-id');
			if (!deviceId) {
				deviceId = crypto.randomUUID();
				localStorage.setItem('browsdr-device-id', deviceId);
			}
			fetch('/api/geo')
				.then((response) => response.json())
				.then((data: unknown) =>
					connection.sendCommand({
						type: 'clientInfo',
						country: isRecord(data) && typeof data.country === 'string' ? data.country : 'XX',
						deviceId,
					}),
				)
				.catch(() => connection.sendCommand({ type: 'clientInfo', country: 'XX', deviceId }));
		}
		if (status.status === 'error' || status.status === 'disconnected') {
			this.error = ('error' in status ? status.error : '') || 'Disconnected from host';
			Promise.resolve(this.disconnectRemote()).catch((error: unknown) => console.error(error));
		}
	};
	try {
		if (!(await runtime.transport.init())) throw new Error('PeerJS could not initialize');
	} catch (error) {
		this.error = errorMessage(error);
		await this.disconnectRemote();
	}
}

async function applyReceivers(this: WorkspaceInstance, runtime: WorkspaceRuntime, inventory: ReceiverInventory[], hostId: string) {
	if (!Array.isArray(inventory) || this.mode !== 'client' || !runtime.transport) return;
	const valid = inventory.filter(validReceiverInventory);
	const connection = runtime.transport;
	const selected = this.selectedId;
	for (const entry of [...this.receivers]) if (!valid.some((item) => item.id === entry.id)) await this.removeReceiver(entry.id);
	for (const item of valid) {
		if (!remoteConnectionActive(this, runtime, connection)) return;
		let app: AppInstance | null | undefined = runtime.instances.get(item.id);
		if (!app) {
			app = await this.newReceiver({
				id: item.id,
				label: item.name || 'Remote SDR',
				settingsKey: `SDRSetting:remote:${hostId}:${item.id}`,
				status: 'Connecting',
				remote: true,
			});
			if (!app || !remoteConnectionActive(this, runtime, connection)) return;
			await initializeRemoteReceiver.call(this, app, item, connection, hostId);
			if (!remoteConnectionActive(this, runtime, connection)) return;
			app.audioUnlockPendingId = hostId;
		}
		const entry = this.receivers.find((entry: ReceiverEntry) => entry.id === item.id);
		if (entry) entry.label = item.name || 'Remote SDR';
		app.handleRemoteCommand({
			type: 'sync',
			radio: item.radio,
			gains: item.gains,
			locks: item.locks,
			capabilities: item.capabilities,
		});
		await syncReceiverAvailability(app, item.running !== false);
	}
	this.selectReceiver(runtime.instances.has(selected) ? selected : this.receivers[0]?.id || '');
	this.remoteStatus = this.receivers.length ? 'Connected to host' : 'Host has no connected receivers';
}

async function disconnectRemote(this: WorkspaceInstance, runtime: WorkspaceRuntime) {
	if (this.mode !== 'client' || this._disconnecting) return;
	this._disconnecting = true;
	const previous = runtime.transport;
	runtime.transport = null;
	runtime.manifestQueue = Promise.resolve();
	previous?.close();
	for (const entry of [...this.receivers]) await this.removeReceiver(entry.id);
	this.mode = 'none';
	window.history.replaceState({}, document.title, '/');
	await this.newReceiver();
	this._disconnecting = false;
}

async function initializeRemoteReceiver(
	this: WorkspaceInstance,
	app: AppInstance,
	item: ReceiverInventory,
	connection: WebRTCHandler,
	hostId: string,
) {
	Object.assign(app.radio, item.radio);
	if (app.vfos.length && Math.abs(app.vfos[0].freq - item.radio.centerFreq) > item.radio.sampleRate / 2e6)
		app.vfos[0].freq = item.radio.centerFreq;
	app._receiverTransport = markRaw(
		new ReceiverTransport(item.id, connection, () => {
			Promise.resolve((() => this.disconnectRemote())()).catch((error: unknown) => console.error(error));
		}),
	);
	await app.connectRemoteClient(hostId);
}

function validReceiverInventory(item: ReceiverInventory): boolean {
	return typeof item?.id === 'string' && Boolean(item.id) && Boolean(item.radio);
}

function remoteConnectionActive(workspace: WorkspaceInstance, runtime: WorkspaceRuntime, connection: WebRTCHandler): boolean {
	return runtime.transport === connection && workspace.mode === 'client';
}
