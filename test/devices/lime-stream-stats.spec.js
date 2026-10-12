import { describe, expect, it } from 'vitest';
import { LimeStreamStats } from '@/devices/limesdr/stream-stats';

function packets(...counters) {
	const data = new DataView(new ArrayBuffer(counters.length * 4096));
	counters.forEach((counter, index) => data.setBigUint64(index * 4096 + 8, BigInt(counter), true));
	return data;
}

describe('LimeSDR source continuity', () => {
	it('counts received traffic independently of DSP and resets its diagnostic baseline', () => {
		const stats = new LimeStreamStats();
		stats.reset(1360, 12, 393216, true);
		stats.observeArrival(500, 0);
		stats.observe(packets(0, 1360));
		stats.observeArrival(1500, 1);
		stats.observe(packets(4080));
		expect(stats.report).toMatchObject({
			usbDiagnosticMode: 1,
			usbElapsedMs: 1000,
			usbTransferCount: 2,
			usbReceivedBytes: 12288,
			usbReceivedSamples: 4080,
			usbLastTransferBytes: 4096,
			sourceMissingSamples: 1360,
		});
		stats.reset();
		expect(stats.report).toMatchObject({
			usbDiagnosticMode: 0,
			usbElapsedMs: 0,
			usbTransferCount: 0,
			usbReceivedBytes: 0,
			usbReceivedSamples: 0,
		});
	});
	it('counts missing samples across USB transfers, not startup or normal packets', () => {
		const stats = new LimeStreamStats();
		stats.observe(packets(500000, 501020));
		stats.observe(packets(504080, 505100));
		expect(stats.report).toMatchObject({ sourceGapCount: 1, sourceMissingSamples: 2040, sourceDiscontinuities: 0 });
		stats.observe(packets(507140));
		expect(stats.report.sourceMissingSamples).toBe(3060);
		stats.reset();
		stats.observe(packets(10000000));
		expect(stats.report).toMatchObject({ sourceGapCount: 0, sourceMissingSamples: 0, sourceDiscontinuities: 0 });
	});
	it('handles unsigned counter rollover and separates resets and duplicate packets from loss', () => {
		const stats = new LimeStreamStats();
		stats.observe(packets((1n << 64n) - 1020n, 0, 1020));
		expect(stats.report.sourceGapCount).toBe(0);
		stats.observe(packets(1020, 0, 1020));
		expect(stats.report).toMatchObject({ sourceGapCount: 0, sourceMissingSamples: 0, sourceDiscontinuities: 2 });
	});
	it('separates in-buffer gaps from boundary gaps and snapshots timing at the last gap', () => {
		const stats = new LimeStreamStats();
		stats.observeArrival(100, 0);
		stats.observe(packets(0, 2040));
		stats.observeService(3);
		stats.observeArrival(150, 1);
		stats.observe(packets(5100, 6120));
		stats.observeService(7);
		stats.observeArrival(152, 2);
		stats.observe(packets(7140));
		expect(stats.report).toMatchObject({
			sourceGapCount: 2,
			sourceMissingSamples: 3060,
			sourceGapWithinTransfer: 1,
			sourceGapBetweenTransfers: 1,
			sourceLargestGapSamples: 2040,
			sourceLastGapArrivalMs: 50,
			sourceLastGapPreviousServiceMs: 3,
			usbArrivalMaxMs: 50,
			usbServiceAvgMs: 5,
			usbServiceMaxMs: 7,
			usbOutOfOrderTransfers: 0,
		});
		stats.reset();
		const { usbLinkBits, usbTransferBytes, ...counters } = stats.report;
		expect(usbLinkBits).toBe(16);
		expect(usbTransferBytes).toBe(524288);
		expect(Object.values(counters).every((value) => value === 0)).toBe(true);
	});
	it('uses packed packet increments, rollover and reset without counting format changes as loss', () => {
		const stats = new LimeStreamStats();
		stats.reset(1360, 12, 393216);
		stats.observe(packets((1n << 64n) - 1360n, 0, 1360));
		expect(stats.report.sourceGapCount).toBe(0);
		stats.observe(packets(4080));
		expect(stats.report).toMatchObject({ sourceGapCount: 1, sourceMissingSamples: 1360, usbLinkBits: 12, usbTransferBytes: 393216 });
		stats.reset(1020, 16, 524288);
		stats.observe(packets(5000, 6020));
		expect(stats.report.sourceGapCount).toBe(0);
	});
	it('reports reordered completions without claiming they prove packet loss', () => {
		const stats = new LimeStreamStats();
		stats.observeArrival(1, 0);
		stats.observeArrival(2, 2);
		stats.observeArrival(3, 1);
		stats.observeArrival(4, 3);
		expect(stats.report.usbOutOfOrderTransfers).toBe(1);
		expect(stats.report.sourceGapCount).toBe(0);
	});
});
