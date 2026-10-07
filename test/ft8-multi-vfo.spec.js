import { afterEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { ft8Methods } from '../src/client/app/ft8';

afterEach(() => vi.unstubAllGlobals());
const frequencies = [1.840, 3.573, 7.074, 10.136, 14.074, 18.100, 21.074, 24.915, 28.074];
function createApp() {
	const workers = [];
	vi.stubGlobal('Worker', class {
		postMessage = vi.fn();
		terminate = vi.fn();
		constructor() { workers.push(this); }
		emit(data) { this.onmessage({ data }); }
	});
	const app = reactive({
		running: true, remoteMode: 'none', gains: { Antenna: 1, 'RX Channel': 0 },
		radio: { centerFreq: 14.96, sampleRate: 30720000, frequencyShift: 0 },
		vfos: frequencies.map(freq => ({ freq, mode: 'usb', bandwidth: 2800, enabled: false, volume: 0, squelchEnabled: true, lowPass: true, highPass: true })),
		ft8: { source: 'all', active: false, channels: {}, log: [], logFilter: 'all' },
		showMsg: vi.fn(), updateAllBackendVfoParams: vi.fn(), $nextTick: callback => callback(), $refs: {},
		...ft8Methods,
	});
	app.startFt8();
	return { app, workers };
}
const result = (text, slot = 15000) => ({ type: 'result', slot, duration: 20, messages: [{ sync: 30, dt: 0.1, hz: 1100, text }] });

describe('simultaneous FT8 VFO reception', () => {
	it('starts nine independent workers and routes every muted source without mixing', () => {
		const { app, workers } = createApp();
		expect(workers).toHaveLength(9);
		workers.forEach((worker, index) => {
			worker.emit({ type: 'ready' });
			app._feedFt8(index, frequencies[index], new Float32Array(2400).fill(index / 10), 12000);
			const message = worker.postMessage.mock.calls.at(-1)[0];
			expect(message.type).toBe('audio');
			expect(new Float32Array(message.samples)[0]).toBeCloseTo(index / 10);
			worker.emit(result(`CQ TEST${index} RF73`));
			expect(app.ft8.channels[index].slots).toBe(1);
		});
		expect(app.ft8.log.map(entry => entry.freq)).toEqual(frequencies);
		expect(app.ft8.log.map(entry => entry.vfoIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
		app.vfos.forEach(vfo => { expect(vfo.enabled).toBe(false); expect(vfo.bandwidth).toBe(3000); expect(vfo.squelchEnabled).toBe(false); });
		app.ft8.logFilter = '4';
		expect(app.ft8VisibleLog()).toHaveLength(1);
	});
	it('retunes one worker without disrupting other bands, ignores stale results, and keeps mute changes out of capture configuration', () => {
		const { app, workers } = createApp();
		app.vfos[4].enabled = true;
		app._ft8ConfigChanged();
		expect(workers).toHaveLength(9);
		app.vfos[4].freq += 0.001;
		app._ft8ConfigChanged();
		expect(workers).toHaveLength(10);
		expect(workers[4].terminate).toHaveBeenCalledOnce();
		workers[4].emit(result('STALE'));
		expect(app.ft8.log).toHaveLength(0);
		workers[9].emit(result('NEW'));
		expect(app.ft8.log[0].freq).toBe(app.vfos[4].freq);
		workers.filter((worker, index) => index !== 4).forEach(worker => expect(worker.terminate).not.toHaveBeenCalled());
	});
	it('updates coverage, source selection, and VFO removal without mislabelling messages', () => {
		const { app, workers } = createApp();
		app.vfos.splice(0, 1);
		app._ft8ConfigChanged();
		workers[0].emit(result('REMOVED'));
		workers[1].emit(result('OLD INDEX'));
		expect(app.ft8.log).toHaveLength(0);
		app._ft8Receivers.get(0).worker.emit(result('CURRENT'));
		expect(app.ft8.log[0]).toMatchObject({ vfoIndex: 0, freq: 3.573 });
		app.ft8.source = '3';
		app._ft8ConfigChanged();
		expect([...app._ft8Receivers.keys()]).toEqual([3]);
		app.radio.sampleRate = 2000000;
		app.radio.centerFreq = 14.074;
		app._ft8ConfigChanged();
		expect([...app._ft8Receivers.keys()]).toEqual([3]);
		app.radio.centerFreq = 50;
		app._ft8ConfigChanged();
		expect(app._ft8Receivers.size).toBe(0);
		expect(app.ft8SourceStatus(3)).toBe('Outside receiver bandwidth');
	});
	it('isolates decoder failure to its VFO and tears down all workers on receiver stop', () => {
		const { app, workers } = createApp();
		workers[0].emit({ type: 'error', error: 'failed' });
		expect(app.ft8.channels[0].status).toBe('Decoder error: failed');
		workers[1].emit(result('STILL RECEIVING'));
		expect(app.ft8.log).toHaveLength(1);
		app.running = false;
		app._ft8ConfigChanged();
		expect(app.ft8.active).toBe(false);
		expect(app._ft8Receivers.size).toBe(0);
		workers.forEach(worker => expect(worker.terminate).toHaveBeenCalled());
		workers[1].emit(result('LATE RESULT'));
		expect(app.ft8.log).toHaveLength(1);
	});
});
