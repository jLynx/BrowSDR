import { describe, expect, it, vi } from 'vitest';
import { WhisperProgress } from '../src/client/whisper-progress';

describe('Whisper download progress', () => {
	it('combines concurrent files and never shows 100% for an incomplete pipeline', () => {
		const send = vi.fn();
		const progress = new WhisperProgress(send);
		progress.update({ status: 'progress', file: 'encoder.onnx', progress: 50, total: 900 });
		progress.update({ status: 'progress', file: 'decoder.onnx', progress: 20, total: 100 });
		progress.update({ status: 'progress', file: 'encoder.onnx', progress: 90, total: 900 });
		progress.update({ status: 'progress', file: 'decoder.onnx', progress: 100, total: 100 });
		const percentages = send.mock.calls.map(([msg]) => msg.progress);
		expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
		expect(percentages.at(-1)).toBe(91);
		expect(send.mock.calls.every(([msg]) => msg.file === '')).toBe(true);
	});
	it('reserves space for weights announced after cached metadata', () => {
		const send = vi.fn();
		const progress = new WhisperProgress(send, 1000);
		progress.update({ status: 'progress', file: 'config.json', progress: 100, total: 100 });
		expect(send.mock.calls.at(-1)[0].progress).toBe(0);
		progress.update({ status: 'progress', file: 'decoder.onnx', progress: 100, total: 200 });
		expect(send.mock.calls.at(-1)[0].progress).toBe(20);
	});
	it('updates completion counts for cached files and distinguishes finalizing from initialization', () => {
		const send = vi.fn();
		const progress = new WhisperProgress(send);
		progress.update({ status: 'initiate', file: 'encoder' });
		progress.update({ status: 'done', file: 'config' });
		expect(send.mock.calls.at(-1)[0]).toMatchObject({ filesDone: 1, filesTotal: 2, phase: 'downloading' });
		progress.update({ status: 'progress', file: 'encoder', progress: 100, total: 900 });
		expect(send.mock.calls.at(-1)[0].phase).toBe('finalizing');
		progress.update({ status: 'done', file: 'encoder' });
		expect(send.mock.calls.at(-1)[0]).toMatchObject({ filesDone: 2, phase: 'initializing' });
	});
});
