import { describe, expect, it, vi } from 'vitest';
import { whisperMethods } from '../src/client/app/whisper';

describe('shared Whisper loading and transcript history', () => {
	it('keeps old history labelled with its model while new model audio is gated off', () => {
		const app = {
			whisper: { active: true, status: 'loading', model: 'distil-whisper/distil-large-v3.5-ONNX', log: [], pendingChunks: 1 },
			_whisperChunkMeta: { 1: { model: 'onnx-community/whisper-large-v3-turbo', freq: '456 MHz' } },
			showMsg: vi.fn(), $nextTick: vi.fn(), _whisperVfoStates: {},
		};
		Object.assign(app, whisperMethods);
		app._onWhisperMessage({ data: { type: 'result', id: 1, text: 'Roger', model: 'onnx-community/whisper-large-v3-turbo' } });
		expect(app.whisper.log[0].model).toBe('onnx-community/whisper-large-v3-turbo');
		app._feedWhisperVfo(0, 456, new Float32Array(48000).fill(0.1));
		expect(app._whisperVfoStates).toEqual({});
		expect(app.whisper.status).toBe('loading');
	});
	it('cancels a stalled load on stop so the next start can create a fresh worker', () => {
		const worker = { terminate: vi.fn() };
		const app = { whisper: { status: 'loading' }, _whisperWorker: worker };
		whisperMethods.stopWhisper.call(app);
		expect(worker.terminate).toHaveBeenCalledOnce();
		expect(app._whisperWorker).toBeNull();
		expect(app.whisper.status).toBe('idle');
	});
	it('preserves the ready worker when stopping normal transcription', () => {
		const worker = { terminate: vi.fn() };
		const app = { whisper: { status: 'ready' }, _whisperWorker: worker };
		whisperMethods.stopWhisper.call(app);
		expect(worker.terminate).not.toHaveBeenCalled();
		expect(app._whisperWorker).toBe(worker);
	});
});
