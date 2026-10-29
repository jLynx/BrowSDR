import { afterEach, describe, expect, it, vi } from 'vitest';
import { Rtk2Tracker } from '@/worker/decoders/rtk/rtk2/tracker';
import { observedSatellites } from '@/app/decoders/rtk/station-details';
import { mockMsm } from '../fixtures/rtk/mock-msm';
import { mockRtk2Packet } from '../fixtures/rtk/mock-rtk2';

afterEach(() => vi.restoreAllMocks());

describe('RTK2 satellite snapshots through reception gaps', () => {
	it('holds the complete count during a missed two-second epoch, then updates all constellations together', () => {
		const tracker = new Rtk2Tracker();
		let now = 1000,
			sequence = 100;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		const ids = (count) => Array.from({ length: count }, (_, i) => i + 1);
		const parts = [
			[1074, ids(11), true],
			[1084, ids(9), true],
			[1094, ids(8), true],
			[1124, ids(12), true],
			[1124, [13, 14, 15], false],
		];
		const send = (part, epoch) => tracker.process(mockRtk2Packet(mockMsm(...part, epoch), sequence++));
		for (const part of parts) {
			send(part, 1000);
			now += 300;
		}
		const station = tracker.snapshot()[0];
		expect(observedSatellites(station, now)).toBe(43);
		expect(new Set(Object.values(station.observations).map((o) => o.receivedAt)).size).toBe(1);
		now = 3000;
		for (let i = 0; i < parts.length; i++) {
			if (i === 2)
				sequence++; // Lost Galileo container; reject this entire MSM sequence.
			else send(parts[i], 2000);
			now += 300;
		}
		expect(tracker.counters.sequenceGaps).toBe(1);
		expect(tracker.snapshot()[0].observations).toEqual(station.observations);
		now = 5000;
		for (const part of parts) {
			send(part, 3000);
			// The first fragments of the original epoch would have expired by now.
			expect(observedSatellites(tracker.snapshot()[0], now)).toBe(43);
			now += 300;
		}
		const completed = tracker.snapshot()[0].observations;
		expect(Object.values(completed).map((o) => o.receivedAt)).toEqual([6200, 6200, 6200, 6200]);
		now = 8000;
		tracker.process(mockRtk2Packet(new Uint8Array(), sequence++));
		expect(tracker.snapshot()[0].observations).toEqual(completed);
		expect(observedSatellites(tracker.snapshot()[0], 11200)).toBe(0);
	});
});
