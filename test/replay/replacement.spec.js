import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IqReplayDevice } from '@/devices/iq-replay';
import { openIqReplay, replaceIqReplay } from '@/worker/recording/replay';

beforeEach(() => vi.stubEnv('DEV', true));
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

function recording(name = 'current.iq', fill = 1) {
	return { file: new File([new Int8Array(100).fill(fill)], name), sampleRate: 1000, centerHz: 923118000, frequencyShiftHz: 0 };
}

function backend() {
	const value = { device: null, stopRx: vi.fn(async () => value.device.stopRx()) };
	openIqReplay.call(value, recording());
	return value;
}

describe('replacing an IQ replay source', () => {
	it('stops the old source and plays the replacement from sample zero on the same backend', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
		const value = backend(),
			previous = value.device,
			oldChunks = [];
		await previous.startRx((bytes) => oldChunks.push(...bytes));
		await vi.advanceTimersByTimeAsync(10);
		const delivered = oldChunks.length;
		expect(delivered).toBeGreaterThan(0);
		const replacement = recording('replacement.iq', 7);
		await replaceIqReplay.call(value, replacement);
		expect(value.stopRx).toHaveBeenCalledOnce();
		expect(value.device).toBeInstanceOf(IqReplayDevice);
		expect(value.device).not.toBe(previous);
		expect(value.device.recording).toBe(replacement);
		expect(value.device.progress).toMatchObject({ state: 'ready', seconds: 0 });
		const newChunks = [];
		await value.device.startRx((bytes) => newChunks.push(...bytes));
		await vi.runAllTimersAsync();
		expect(oldChunks).toHaveLength(delivered);
		expect(newChunks).toEqual(new Array(100).fill(7));
		await value.device.close();
	});
	it('validates before stopping so invalid files leave playback untouched', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
		const value = backend(),
			previous = value.device;
		await previous.startRx(vi.fn());
		await vi.advanceTimersByTimeAsync(10);
		const progress = previous.progress;
		await expect(replaceIqReplay.call(value, { ...recording(), file: new File([new Uint8Array(3)], 'invalid.iq') })).rejects.toThrow(
			'pairs',
		);
		expect(value.stopRx).not.toHaveBeenCalled();
		expect(value.device).toBe(previous);
		expect(previous.progress).toEqual(progress);
		expect(progress.state).toBe('playing');
		await previous.close();
	});
	it('requires an existing replay receiver without stopping hardware', async () => {
		const value = { device: { deviceType: 'hackrf' }, stopRx: vi.fn() };
		await expect(replaceIqReplay.call(value, recording())).rejects.toThrow('Connect an IQ recording first');
		expect(value.stopRx).not.toHaveBeenCalled();
	});
	it('disables opening and replacing replay sources in production', async () => {
		const value = backend(),
			previous = value.device;
		vi.stubEnv('DEV', false);
		expect(() => openIqReplay.call({ device: null }, recording())).toThrow('only available in development');
		await expect(replaceIqReplay.call(value, recording())).rejects.toThrow('only available in development');
		expect(value.device).toBe(previous);
		expect(value.stopRx).not.toHaveBeenCalled();
		await previous.close();
	});
});
