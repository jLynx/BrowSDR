import { describe, expect, it } from 'vitest';
import { RtkTracker } from '@/worker/decoders/rtk/rtcm';
import { mockRadioPayload } from '../fixtures/rtk/mock-packet';

const stationA = { scan: 1234, channel: 7, netId: 42 };
const stationB = { scan: 2345, channel: 8, netId: 43 };

function fragments(radio) {
	const length = (radio[10] ^ 0x12) + 6;
	return [radio.slice(8, 18), radio.slice(18, 8 + length)].map((body) => ({
		data: Uint8Array.from([...radio.slice(0, 7), body.length, ...body]),
		verified: true,
		cfoHz: 0,
	}));
}

describe('multiple RTK bases on one radio channel', () => {
	it('reassembles alternating bases independently even with the same RTCM station ID', () => {
		const a = fragments(mockRadioPayload(stationA));
		const b = fragments(mockRadioPayload(stationB, [0, 63781370000, 0]));
		const tracker = new RtkTracker();
		for (const packet of [a[0], b[0], a[1], b[1]]) tracker.process(packet);
		const stations = tracker.snapshot();
		expect(stations).toHaveLength(2);
		expect(stations.find((station) => station.scan === stationA.scan)).toMatchObject({
			...stationA,
			rtcmCount: 1,
			packets: 2,
			reference: { stationId: 42, latitude: 0, longitude: 0 },
		});
		expect(stations.find((station) => station.scan === stationB.scan)).toMatchObject({
			...stationB,
			rtcmCount: 1,
			packets: 2,
			reference: { stationId: 42, latitude: 0, longitude: 90 },
		});
		expect(tracker.flush().map((frame) => [frame.source, frame.stationId])).toEqual([
			['1234.7.42', 42],
			['2345.8.43', 42],
		]);
	});

	it('clears all incomplete bases on lost or unchecked data and recovers on complete frames', () => {
		const a = fragments(mockRadioPayload(stationA)),
			b = fragments(mockRadioPayload(stationB));
		const tracker = new RtkTracker();
		for (const packet of [a[0], b[0], { ...a[0], verified: false }, a[1], b[1]]) tracker.process(packet);
		expect(tracker.flush()).toEqual([]);
		tracker.discontinuity();
		for (const packet of [...a, ...b]) tracker.process(packet);
		expect(tracker.flush()).toHaveLength(2);
	});

	it('bounds base identities and evicts their incomplete fragments together', () => {
		const tracker = new RtkTracker(),
			a = fragments(mockRadioPayload(stationA));
		tracker.process(a[0]);
		for (let scan = 10; scan < 26; scan++) tracker.process(fragments(mockRadioPayload({ ...stationA, scan }))[0]);
		expect(tracker.snapshot()).toHaveLength(16);
		expect(tracker.snapshot().some((station) => station.scan === stationA.scan)).toBe(false);
		tracker.process(a[1]);
		expect(tracker.flush()).toEqual([]);
	});
});
