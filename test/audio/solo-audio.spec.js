import { describe, expect, it, vi } from 'vitest';
import { vfoMethods } from '@/app/radio/vfo';
import { computedProperties } from '@/app/core/computed';

function receiver() {
	const app = {
		vfos: Array.from({ length: 3 }, () => ({ enabled: true, freq: 100, mode: 'dsd', volume: 50 })),
		radio: { centerFreq: 100, sampleRate: 2000000 },
		soloAudioVfo: null,
		running: true,
		vfoSquelchOpen: [],
		backend: { setVfoParams: vi.fn(), removeVfo: vi.fn() },
		isFreqInBandwidth: () => true,
		_initAudioCtx: vi.fn(),
		activeVfoIndex: 0,
	};
	Object.assign(app, vfoMethods);
	Object.defineProperty(app, 'activeAudioVfos', { get: () => computedProperties.activeAudioVfos.call(app) });
	return app;
}

describe('isolated VFO audio', () => {
	it('switches isolated channels and restores the mix without changing enabled state or volume', () => {
		const app = receiver();
		app.toggleSoloAudio(1);
		expect(app.backend.setVfoParams.mock.calls.map(([, params]) => params.audioMuted)).toEqual([true, false, true]);
		app.toggleSoloAudio(2);
		expect(app.soloAudioVfo).toBe(app.vfos[2]);
		app.toggleSoloAudio(2);
		expect(app.soloAudioVfo).toBeNull();
		expect(app.backend.setVfoParams.mock.calls.slice(-3).every(([, params]) => !params.audioMuted)).toBe(true);
		expect(app.vfos.every((vfo) => vfo.enabled && vfo.volume === 50)).toBe(true);
	});
	it('clears isolation and restores the mix when decoded voice activity ends', () => {
		const app = receiver();
		app.vfoSquelchOpen = [false, true, true];
		app.toggleSoloAudio(1);
		app.clearInactiveSoloAudio();
		expect(app.soloAudioVfo).toBe(app.vfos[1]);
		app.vfoSquelchOpen[1] = false;
		app.clearInactiveSoloAudio();
		expect(app.soloAudioVfo).toBeNull();
		expect(app.activeAudioVfos.map((item) => item.index)).toEqual([2]);
		expect(app.backend.setVfoParams.mock.calls.slice(-3).every(([, params]) => !params.audioMuted)).toBe(true);
		app.vfoSquelchOpen[1] = true;
		app.clearInactiveSoloAudio();
		expect(app.soloAudioVfo).toBeNull();
	});
	it('clears analog isolation when squelch closes or reception stops', () => {
		const app = receiver();
		app.vfos[0].mode = 'nfm';
		app.vfos[0].squelchEnabled = true;
		app.vfoSquelchOpen[0] = true;
		app.toggleSoloAudio(0);
		app.vfoSquelchOpen[0] = false;
		app.clearInactiveSoloAudio();
		expect(app.soloAudioVfo).toBeNull();
		app.vfos[0].squelchEnabled = false;
		app.toggleSoloAudio(0);
		app.running = false;
		app.clearInactiveSoloAudio();
		expect(app.soloAudioVfo).toBeNull();
	});
	it('preserves isolation across index shifts and restores other audio when the isolated VFO is removed', async () => {
		const app = receiver();
		app.toggleSoloAudio(1);
		const selected = app.vfos[1];
		await app.removeVfo(0);
		expect(app.soloAudioVfo).toBe(selected);
		await app.removeVfo(0);
		expect(app.soloAudioVfo).toBeNull();
		expect(app.backend.setVfoParams.mock.calls.at(-1)[1].audioMuted).toBe(false);
	});
	it('restores the mix if the isolated VFO is manually muted', () => {
		const app = receiver();
		app.toggleSoloAudio(1);
		app.vfos[1].enabled = false;
		app.toggleVfoCheckbox(1);
		expect(app.soloAudioVfo).toBeNull();
	});
});
