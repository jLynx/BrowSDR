import { afterEach, describe, expect, it, vi } from 'vitest';
import { packReceiverChunk, unpackReceiverChunk, ReceiverTransport } from '../src/client/receiver-transport';
import { createWorkspace, syncReceiverAvailability } from '../src/client/app/workspace';
import { remoteMethods } from '../src/client/app/remote';
import { bookmarkMethods } from '../src/client/app/bookmarks';
import { reactive } from 'vue';

vi.mock('../src/client/webrtc', () => ({
	PEER_ID_PREFIX: 'browsdr-',
	WebRTCHandler: class {
		async init() { return true; }
		close() {}
	},
}));

afterEach(() => vi.unstubAllGlobals());

describe('multiplexed SDR streams', () => {
	it('keeps audio bytes, typed-array offsets and receiver IDs separate across many receivers', () => {
		const audio = new Float32Array([99, 0.25, -0.5, 99]).subarray(1, 3);
		for (let index = 0; index < 12; index++) {
			const id = `receiver-${index}-📻`;
			const decoded = unpackReceiverChunk(packReceiverChunk(id, audio));
			expect(decoded.receiverId).toBe(id);
			expect([...new Float32Array(decoded.payload)]).toEqual([0.25, -0.5]);
		}
	});
	it('supports original single-radio payloads and rejects incomplete envelopes', () => {
		expect(unpackReceiverChunk(new Uint8Array([255, 218, 1, 0, 40]))).toMatchObject({ receiverId: null });
		const packet = new Uint8Array(packReceiverChunk('lime', new Uint8Array([42])));
		expect(unpackReceiverChunk(packet.subarray(0, 5))).toBeNull();
		expect(unpackReceiverChunk(packet.subarray(0, 8))).toBeNull();
		expect(() => packReceiverChunk('', new Uint8Array(4))).toThrow();
	});
	it('routes commands and both binary channels over one transport without modifying payloads', () => {
		const connection = { sendCommand: vi.fn(), sendCommandTo: vi.fn(), sendFftChunk: vi.fn(), sendAudioChunkTo: vi.fn() };
		const lime = new ReceiverTransport('lime', connection, vi.fn());
		const hackrf = new ReceiverTransport('hackrf', connection, vi.fn());
		lime.sendCommand({ type: 'vfoUpdate', index: 0 });
		hackrf.sendCommandTo('alice', { type: 'rds', vfoIndex: 0 });
		lime.sendFftChunk(new Uint8Array([255, 218, 1, 0, 60]));
		hackrf.sendAudioChunkTo('alice', new Float32Array([0.125]));
		expect(connection.sendCommand).toHaveBeenCalledWith({ type: 'vfoUpdate', index: 0, receiverId: 'lime' });
		expect(connection.sendCommandTo).toHaveBeenCalledWith('alice', { type: 'rds', vfoIndex: 0, receiverId: 'hackrf' });
		expect(unpackReceiverChunk(connection.sendFftChunk.mock.calls[0][0]).receiverId).toBe('lime');
		const decoded = unpackReceiverChunk(connection.sendAudioChunkTo.mock.calls[0][1]);
		expect(decoded.receiverId).toBe('hackrf');
		expect(new Float32Array(decoded.payload)[0]).toBe(0.125);
	});
});

function makeWorkspace() {
	vi.stubGlobal('RTCPeerConnection', vi.fn());
	vi.stubGlobal('window', { location: { hostname: 'localhost' }, history: { replaceState: vi.fn() } });
	vi.stubGlobal('document', { title: 'BrowSDR' });
	const options = createWorkspace({});
	const workspace = { ...options.data(), $nextTick: async () => {} };
	for (const [name, method] of Object.entries(options.methods)) workspace[name] = method.bind(workspace);
	return workspace;
}

function makeReceiver(id, connected = true) {
	return {
		receiverId: id, connected, running: connected, info: { boardName: id },
		$watch: vi.fn(), _backendWorker: { terminate: vi.fn() },
		_disconnectReceiver: vi.fn(), _initAudioCtx: vi.fn(), loadSetting: vi.fn(), showMsg: vi.fn(),
		_connectToDevice: vi.fn(), _connectMock: vi.fn(),
	};
}

describe('receiver membership', () => {
	it('migrates the first physical SDR after a remote session regardless of runtime ID', async () => {
		const workspace = makeWorkspace();
		workspace.mode = 'client';
		const disconnect = workspace.disconnectRemote();
		await vi.waitFor(() => expect(workspace.receivers[0]?.id).toBe('local-2'));
		const first = makeReceiver('local-2', false);
		workspace.registerReceiver('local-2', first);
		await disconnect;
		const devices = [{ vendorId: 1, productId: 2, serialNumber: 'one' }, { vendorId: 1, productId: 2, serialNumber: 'two' }];
		vi.stubGlobal('navigator', { usb: { getDevices: async () => devices } });
		first._connectToDevice.mockImplementation(async () => { first.connected = true; });
		await workspace.connectDevice(first, devices[0]);
		expect(first.loadSetting).toHaveBeenCalledWith(true);
		const adding = workspace.connectDevice(first, devices[1]);
		const second = makeReceiver('local-3');
		workspace.registerReceiver('local-3', second);
		await adding;
		expect(second.loadSetting).toHaveBeenCalledWith(false);
	});
	it('cancels pending remote receivers and accepts a new session before old initialization finishes', async () => {
		const workspace = makeWorkspace();
		await workspace.connectRemote('host');
		const applying = workspace.applyReceivers([{ id: 'remote-1', radio: { centerFreq: 100, sampleRate: 2000000 } }], 'host');
		expect(workspace.receivers.map(entry => entry.id)).toEqual(['remote-1']);
		const disconnect = workspace.disconnectRemote();
		await applying;
		await vi.waitFor(() => expect(workspace.receivers[0]?.id).toBe('local-2'));
		const late = makeReceiver('remote-1');
		expect(workspace.registerReceiver('remote-1', late)).toBe(false);
		expect(late._backendWorker.terminate).toHaveBeenCalledOnce();
		workspace.registerReceiver('local-2', makeReceiver('local-2', false));
		await disconnect;
		await workspace.connectRemote('next-host');
		const nextInventory = workspace.applyReceivers([{ id: 'remote-2', radio: { centerFreq: 435, sampleRate: 2000000 } }], 'next-host');
		const next = { ...makeReceiver('remote-2'), radio: {}, vfos: [{ freq: 435 }], connectRemoteClient: vi.fn(), handleRemoteCommand: vi.fn() };
		workspace.registerReceiver('remote-2', next);
		await nextInventory;
		expect(next.connectRemoteClient).toHaveBeenCalledWith('next-host');
		expect(workspace.receivers.map(entry => entry.id)).toEqual(['remote-2']);
	});
	it('preserves client pause choices across inventory changes and host restarts', async () => {
		const receiver = makeReceiver('local-1');
		receiver.running = false;
		receiver._hostRunning = true;
		receiver.handleRemoteCommand = vi.fn();
		receiver.startStream = vi.fn(async () => { receiver.running = true; });
		receiver.togglePlay = vi.fn(async () => { receiver.running = !receiver.running; });
		await syncReceiverAvailability(receiver, true);
		await syncReceiverAvailability(receiver, false);
		await syncReceiverAvailability(receiver, true);
		expect(receiver.running).toBe(false);
		expect(receiver.startStream).not.toHaveBeenCalled();
		receiver.running = true;
		await syncReceiverAvailability(receiver, false);
		await syncReceiverAvailability(receiver, false);
		expect(receiver.togglePlay).toHaveBeenCalledOnce();
		await syncReceiverAvailability(receiver, true);
		expect(receiver.startStream).toHaveBeenCalledWith(true);
		expect(receiver.running).toBe(true);
	});
	it('adds a physical SDR without opening or stopping the existing receiver and rejects duplicate pairing', async () => {
		const workspace = makeWorkspace();
		const lime = makeReceiver('local-1');
		workspace.registerReceiver('local-1', lime);
		const device = { vendorId: 7504, productId: 24713, serialNumber: 'hackrf-1' };
		vi.stubGlobal('navigator', { usb: { getDevices: async () => [device] } });
		const hackrf = makeReceiver('local-2');
		workspace.newReceiver = async () => {
			workspace.receivers.push({ id: 'local-2', settingsKey: '', label: 'HackRF' });
			workspace.registerReceiver('local-2', hackrf);
			return hackrf;
		};
		await workspace.connectDevice(lime, device);
		expect(hackrf._connectToDevice).toHaveBeenCalledWith(device, 0);
		expect(lime._connectToDevice).not.toHaveBeenCalled();
		expect(lime._disconnectReceiver).not.toHaveBeenCalled();
		await workspace.connectDevice(lime, device);
		expect(lime.showMsg).toHaveBeenCalledWith('This SDR is already connected.');
		expect(workspace.receivers).toHaveLength(2);
	});
	it('removes one receiver while the others keep their worker and connection', async () => {
		const workspace = makeWorkspace();
		const lime = makeReceiver('local-1');
		const hackrf = makeReceiver('local-2');
		workspace.receivers.push({ id: 'local-2' });
		workspace.registerReceiver('local-1', lime);
		workspace.registerReceiver('local-2', hackrf);
		await workspace.removeReceiver('local-2');
		expect(hackrf._disconnectReceiver).toHaveBeenCalledOnce();
		expect(hackrf._backendWorker.terminate).toHaveBeenCalledOnce();
		expect(lime._disconnectReceiver).not.toHaveBeenCalled();
		expect(lime._backendWorker.terminate).not.toHaveBeenCalled();
		expect(workspace.receivers.map(entry => entry.id)).toEqual(['local-1']);
	});
	it('keeps many mock receivers rather than replacing the existing receiver', async () => {
		const workspace = makeWorkspace();
		const source = makeReceiver('local-1');
		workspace.registerReceiver('local-1', source);
		let index = 1;
		workspace.newReceiver = async () => {
			const id = `local-${++index}`;
			const app = makeReceiver(id);
			workspace.receivers.push({ id });
			workspace.registerReceiver(id, app);
			return app;
		};
		for (let count = 0; count < 8; count++) await workspace.connectDevice(source, 'mock');
		expect(workspace.receivers).toHaveLength(9);
		expect(source._connectMock).not.toHaveBeenCalled();
	});
});

describe('per-receiver remote controls', () => {
	it.each([
		['LNA', 1, false], ['LNA', 8, true], ['LNA', 40, true],
		['VGA', 1, false], ['VGA', 62, true],
		['Antenna', 0.5, false], ['Antenna', 2, true],
		['Bias-T', 0.5, false], ['Bias-T', 1, true],
	])('validates %s gain %s against advertised steps', (property, value, accepted) => {
		const host = { remoteMode: 'host', radio: {}, gains: {}, locks: {},
			deviceCapabilities: { gainControls: [
				{ name: 'LNA', min: 0, max: 40, step: 8 },
				{ name: 'VGA', min: 0, max: 62, step: 2 },
				{ name: 'Antenna', min: 0, max: 2, step: 1 },
				{ name: 'Bias-T', min: 0, max: 1, step: 1 },
			] }, _webrtc: { sendCommand: vi.fn() } };
		remoteMethods.handleRemoteCommand.call(host, 'alice', { type: 'requestChange', target: 'gains', property, value });
		expect(host.gains[property]).toBe(accepted ? value : undefined);
		expect(host._webrtc.sendCommand).toHaveBeenCalledTimes(accepted ? 1 : 0);
	});
	it('cannot replace host state using a client sync message or change an unsupported property', () => {
		const host = { remoteMode: 'host', radio: { centerFreq: 106.2, frequencyShift: 0 }, gains: {}, locks: {} };
		remoteMethods.handleRemoteCommand.call(host, 'alice', { type: 'sync', radio: { centerFreq: 435 } });
		remoteMethods.handleRemoteCommand.call(host, 'alice', { type: 'requestChange', target: 'radio', property: 'frequencyShift', value: -125 });
		expect(host.radio).toEqual({ centerFreq: 106.2, frequencyShift: 0 });
	});
	it('rejects unsupported sample rates and enforces the selected receiver lock', () => {
		const host = { remoteMode: 'host', radio: { sampleRate: 2000000 }, gains: {}, locks: { sampleRate: true },
			deviceCapabilities: { sampleRates: [2000000, 4000000], gainControls: [] },
			_webrtc: { sendCommandTo: vi.fn(), sendCommand: vi.fn() } };
		remoteMethods.handleRemoteCommand.call(host, 'alice', { type: 'requestChange', target: 'radio', property: 'sampleRate', value: 61440000 });
		remoteMethods.handleRemoteCommand.call(host, 'alice', { type: 'requestChange', target: 'radio', property: 'sampleRate', value: 4000000 });
		expect(host.radio.sampleRate).toBe(2000000);
		expect(host._webrtc.sendCommandTo).toHaveBeenCalledWith('alice', expect.objectContaining({ type: 'sync' }));
	});
});

describe('shared receiver bookmarks', () => {
	it('loads existing bookmarks once without replacing the collection referenced by receivers', () => {
		vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([{ id: 'saved', name: 'Saved' }]) });
		const workspace = reactive(makeWorkspace());
		const shared = workspace.bookmarks;
		bookmarkMethods.loadBookmarks.call(workspace);
		expect(workspace.bookmarks).toBe(shared);
		expect(shared).toEqual([{ type: 'group', id: 'saved', name: 'Saved' }]);
		shared.push({ id: 'new', name: 'New' });
		const app = { workspace, bookmarks: shared };
		bookmarkMethods.loadBookmarks.call(app);
		expect(app.bookmarks).toBe(shared);
		expect(shared.map(item => item.id)).toEqual(['saved', 'new']);
	});
	it('preserves saves, edits, deletions and replacement imports across mounted receivers', () => {
		const storage = new Map();
		vi.stubGlobal('localStorage', { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) });
		const workspace = reactive(makeWorkspace());
		const makeApp = () => ({ workspace, bookmarks: workspace.bookmarks, bookmarkModal: { type: 'individual', name: 'First', category: '' },
			vfos: [{ freq: 100, mode: 'wfm' }], activeVfoIndex: 0, showMsg: vi.fn(),
			saveBookmarks: bookmarkMethods.saveBookmarks, bookmarkImportModal: {}, _pendingImportFile: {} });
		const first = makeApp(), second = makeApp();
		bookmarkMethods.confirmBookmark.call(first);
		second.bookmarkModal.name = 'Second';
		bookmarkMethods.confirmBookmark.call(second);
		expect(JSON.parse(storage.get('sdr-web-bookmarks')).map(item => item.name)).toEqual(['First', 'Second']);
		first.bookmarkEdit = { index: 0, name: 'Edited', category: '', type: 'individual', freq: '101', mode: 'wfm' };
		bookmarkMethods.confirmEditBookmark.call(first);
		expect(second.bookmarks.some(item => item.name === 'Edited')).toBe(true);
		bookmarkMethods.deleteBookmark.call(second, second.bookmarks.findIndex(item => item.name === 'Second'));
		expect(first.bookmarks).toHaveLength(1);
		vi.stubGlobal('FileReader', class { readAsText() { this.onload({ target: { result: JSON.stringify([{ name: 'Imported', freq: 102, type: 'individual' }]) } }); } });
		bookmarkMethods.confirmImport.call(second, 'replace');
		expect(first.bookmarks).toBe(second.bookmarks);
		expect(first.bookmarks.map(item => item.name)).toEqual(['Imported']);
		first.bookmarkModal.name = 'Third';
		bookmarkMethods.confirmBookmark.call(first);
		expect(JSON.parse(storage.get('sdr-web-bookmarks'))).toHaveLength(2);
	});
});
