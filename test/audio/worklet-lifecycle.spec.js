import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioMethods } from '@/app/audio/audio';

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
});
