import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializePerformanceReporting } from '@/worker/streams/performance';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('cumulative IQ drops', () => {
	it('retains brief drops across idle reports, forwards the total, and resets for a new stream', () => {
		vi.useFakeTimers();
		let now = 0;
		vi.stubGlobal('performance', { now: () => now });
		const backend = {
			_remoteClients: new Map([['client', {}]]),
			_remoteHostStatsCb: vi.fn(),
			device: { getRxStreamStats: () => ({ sourceGapCount: 1, sourceMissingSamples: 1020, sourceDiscontinuities: 0 }) },
		};
		const channels = { calls: 0, sum: 0, max: 0 };
		const perf = initializePerformanceReporting(backend, channels, 61440000);
		const tick = () => {
			now += 500;
			vi.advanceTimersByTime(500);
		};
		perf.droppedChunks = 3;
		tick();
		expect(perf.report).toMatchObject({ dropped: 3, droppedTotal: 3 });
		expect(perf.droppedChunks).toBe(0);
		tick();
		expect(perf.report).toMatchObject({ dropped: 0, droppedTotal: 3 });
		perf.droppedChunks = 2;
		tick();
		expect(perf.report.droppedTotal).toBe(5);
		expect(backend._remoteHostStatsCb).toHaveBeenLastCalledWith(
			'client',
			expect.objectContaining({ droppedTotal: 5, sourceMissingSamples: 1020 }),
		);
		clearInterval(backend._perfInterval);
		const restarted = initializePerformanceReporting(backend, channels, 61440000);
		tick();
		expect(restarted.report).toMatchObject({ dropped: 0, droppedTotal: 0 });
		clearInterval(backend._perfInterval);
	});
});
