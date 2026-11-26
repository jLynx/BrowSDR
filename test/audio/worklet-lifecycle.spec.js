import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioMethods } from '@/app/audio/audio';
import { playRemoteAudio, recordRemotePacketArrival } from '@/app/audio/remote';
import { packAudio } from '@/audio/pcm';

afterEach(() => vi.unstubAllGlobals());

function receiver(addModule = () => Promise.resolve()) {
	const nodes = [];
	vi.stubGlobal(
		'AudioWorkletNode',
		class {
			constructor() {
				this.port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
				this.connect = vi.fn();
				this.disconnect = vi.fn();
				nodes.push(this);
			}
		},
	);
	return {
		app: { ...audioMethods, audioCtx: { audioWorklet: { addModule }, state: 'running' }, gainNode: {}, vfos: [{ enabled: true }] },
		nodes,
	};
}

describe('audio worklet ownership', () => {
	it('initializes once, forwards stereo by transfer, and detaches on stop', async () => {
		const addModule = vi.fn(() => Promise.resolve());
		const { app, nodes } = receiver(addModule);
		await Promise.all([app._prepareAudioWorklet(), app._prepareAudioWorklet()]);
		expect(addModule).toHaveBeenCalledTimes(1);
		const node = nodes[0];
		const pcm = new Float32Array([1, -1, 0.5, -0.5]);
		app.playAudio(pcm, 2);
		expect(node.port.postMessage).toHaveBeenCalledWith({ type: 'pcm', samples: pcm, channels: 2 }, [pcm.buffer]);
		app.vfos[0].enabled = false;
		app.playAudio(pcm, 2);
		app.playAudio(pcm, 2);
		expect(node.port.postMessage).toHaveBeenCalledTimes(2);
		app._disposeAudioWorklet();
		expect(node.disconnect).toHaveBeenCalled();
		expect(node.port.close).toHaveBeenCalled();
		expect(node.port.onmessage).toBeNull();
	});
	it.each([false, true])('does not attach a module disposed while loading (replace context: %s)', async (replaceContext) => {
		let finish;
		const { app, nodes } = receiver(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const pending = app._prepareAudioWorklet();
		app._disposeAudioWorklet();
		if (replaceContext) app.audioCtx = null;
		finish();
		await pending;
		expect(nodes).toHaveLength(0);
	});
	it('measures remote arrivals and sends host PCM straight to the worklet with transcription intact', async () => {
		const { app, nodes } = receiver();
		app.remoteMode = 'client';
		app.vfos[0].freq = 106.2;
		app.whisper = { active: false, status: 'ready' };
		app._feedWhisperVfo = vi.fn((_, __, samples) => expect(samples.byteLength).toBeGreaterThan(0));
		await app._prepareAudioWorklet();
		app._resetAudioPlayback(true);
		const { port } = nodes[0];
		expect(port.postMessage).toHaveBeenCalledWith({ type: 'reset', clearCounters: true, maxBufferMs: 500 });

		recordRemotePacketArrival(app, 100);
		expect(app.remotePacketGapMs).toBeNull();
		recordRemotePacketArrival(app, 548);
		recordRemotePacketArrival(app, 556);
		expect(app.remotePacketGapMs).toBe(448);

		const played = [];
		port.postMessage.mockImplementation((message, transfer) => played.push(structuredClone(message, { transfer })));
		playRemoteAudio(app, new Float32Array([0.25, 0.5]).buffer);
		expect(app._feedWhisperVfo).not.toHaveBeenCalled();
		app.whisper.active = true;
		playRemoteAudio(app, new Float32Array([0.25, 0.5]).buffer);
		playRemoteAudio(app, packAudio(new Float32Array([1, 0, 0.5, 0.5]), 2));
		expect(app._feedWhisperVfo).toHaveBeenNthCalledWith(1, 0, 106.2, new Float32Array([0.25, 0.5]));
		expect(app._feedWhisperVfo).toHaveBeenNthCalledWith(2, 0, 106.2, new Float32Array([0.5, 0.5]));
		expect(played).toEqual([
			{ type: 'pcm', samples: new Float32Array([0.25, 0.5]), channels: 1 },
			{ type: 'pcm', samples: new Float32Array([0.25, 0.5]), channels: 1 },
			{ type: 'pcm', samples: new Float32Array([1, 0, 0.5, 0.5]), channels: 2 },
		]);
	});
});
