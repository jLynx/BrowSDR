import { afterEach, describe, expect, it, vi } from 'vitest';
import { whisperMethods } from '@/app/decoders/whisper';

function receiver(mode = 'dsd', squelchEnabled = false) {
	const app = {
		whisper: { active: true, status: 'ready', chunkSeconds: 10, pendingChunks: 0 },
		vfos: [
			{ mode, squelchEnabled },
			{ mode, squelchEnabled },
		],
		activeAudioVfos: [{ index: 0 }, { index: 1 }],
		_whisperVfoStates: {},
		_whisperChunkId: 0,
		_whisperChunkMeta: {},
		_whisperWorker: { postMessage: vi.fn() },
		formatFreq: (freq) => String(freq),
	};
	Object.assign(app, whisperMethods);
	return app;
}
afterEach(() => vi.useRealTimers());
const voice = (seconds) => new Float32Array(48000 * seconds).fill(0.08);
const silence = (seconds) => new Float32Array(48000 * seconds);

describe('short DMR transmissions to Whisper', () => {
	it('waits through silence while the bubble remains, then submits when it disappears', () => {
		vi.useFakeTimers();
		const app = receiver();
		app._feedWhisperVfo(0, 455.981, voice(2));
		app._feedWhisperVfo(0, 455.981, silence(0.5));
		vi.advanceTimersByTime(2000);
		app.flushInactiveWhisperVfos();
		expect(app._whisperWorker.postMessage).not.toHaveBeenCalled();
		app.activeAudioVfos = [{ index: 1 }];
		app.flushInactiveWhisperVfos();
		const [msg] = app._whisperWorker.postMessage.mock.calls[0];
		expect(msg.audioDuration).toBe(2.5);
		expect(msg.audio.length).toBe(40000);
		vi.advanceTimersByTime(1000);
		expect(app._whisperWorker.postMessage).toHaveBeenCalledTimes(1);
	});
	it('flushes on bubble removal even without further callbacks and keeps VFO calls separate', () => {
		vi.useFakeTimers();
		const app = receiver();
		app._feedWhisperVfo(0, 455.981, voice(2));
		vi.advanceTimersByTime(300);
		app._feedWhisperVfo(1, 456.131, voice(1));
		vi.advanceTimersByTime(300);
		app.activeAudioVfos = [{ index: 1 }];
		app.flushInactiveWhisperVfos();
		expect(app._whisperWorker.postMessage).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(300);
		app.activeAudioVfos = [];
		app.flushInactiveWhisperVfos();
		expect(app._whisperWorker.postMessage).toHaveBeenCalledTimes(2);
		expect(Object.values(app._whisperChunkMeta).map((meta) => meta.vfoIndex)).toEqual([0, 1]);
	});
	it('does not split a brief gap but caps a long DMR call at the selected chunk length', () => {
		vi.useFakeTimers();
		const app = receiver();
		app._feedWhisperVfo(0, 455.981, voice(2));
		app._feedWhisperVfo(0, 455.981, silence(0.2));
		vi.advanceTimersByTime(200);
		app._feedWhisperVfo(0, 455.981, voice(7.8));
		expect(app._whisperWorker.postMessage.mock.calls[0][0].audioDuration).toBe(10);
		vi.advanceTimersByTime(1000);
		expect(app._whisperWorker.postMessage).toHaveBeenCalledTimes(1);
	});
	it('does not flush stopped transcription', () => {
		vi.useFakeTimers();
		const app = receiver();
		app._feedWhisperVfo(0, 455.981, voice(2));
		app.stopWhisper();
		app.activeAudioVfos = [];
		app.flushInactiveWhisperVfos();
		vi.advanceTimersByTime(1000);
		expect(app._whisperWorker.postMessage).not.toHaveBeenCalled();
	});
	it('splits an oversized audio callback exactly at the dropdown limit', () => {
		const app = receiver();
		app.whisper.chunkSeconds = 3;
		app._feedWhisperVfo(0, 455.981, voice(7));
		expect(app._whisperWorker.postMessage.mock.calls.map(([msg]) => msg.audioDuration)).toEqual([3, 3]);
		app.activeAudioVfos = [];
		app.flushInactiveWhisperVfos();
		expect(app._whisperWorker.postMessage.mock.calls.at(-1)[0].audioDuration).toBe(1);
	});
	it('waits for an activity snapshot when audio arrives before the bubble appears', () => {
		const app = receiver();
		app.activeAudioVfos = [];
		app._feedWhisperVfo(0, 455.981, voice(2));
		app.flushInactiveWhisperVfos();
		expect(app._whisperWorker.postMessage).not.toHaveBeenCalled();
		app.activeAudioVfos = [{ index: 0 }];
		app.flushInactiveWhisperVfos();
		app.activeAudioVfos = [];
		app.flushInactiveWhisperVfos();
		expect(app._whisperWorker.postMessage).toHaveBeenCalledTimes(1);
	});
	it('preserves fixed chunks for unsquelched analog audio', () => {
		vi.useFakeTimers();
		const app = receiver('nfm');
		app._feedWhisperVfo(0, 455.981, voice(2));
		app._feedWhisperVfo(0, 455.981, silence(1));
		vi.advanceTimersByTime(1000);
		expect(app._whisperWorker.postMessage).not.toHaveBeenCalled();
	});
});
