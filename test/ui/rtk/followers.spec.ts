import { describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';
import { makeDefaultVfo } from '@/app/core/constants';
import type { AppInstance } from '@/app/core/receiver.types';
import type { RtkStation } from '@/worker/decoders/rtk/types';
import { discoverFollowers, MAX_RTK_TRACKERS } from '@/app/decoders/rtk/discovery/followers';
import { collectStations } from '@/app/decoders/rtk/stations';

function station(prefix = 100, profile: 'rtk2' | 'rtk3' = 'rtk3'): RtkStation {
	return {
		name: 'RTK base station',
		netId: 42,
		address: 42,
		addressPrefix: prefix,
		...(profile === 'rtk2' ? ({ protocol: 'rtk2', network: String(prefix) } as const) : {}),
		packets: 2,
		lastSeen: Date.now(),
		rtcmCount: 0,
		rtcmTypes: {},
		cfoHz: 0,
		discovery: {
			profile,
			frequencyMHz: 915.401,
			latestFrequencyMHz: 921.401,
			frequenciesMHz: [915.401, 921.401],
			hoppingObserved: true,
			verifiedFrames: 2,
		},
	};
}

function setup() {
	const receiver = reactive({
		running: true,
		vfos: [{ ...makeDefaultVfo(923.118), rtk: true, rtkProfile: 'scan' as const }],
		radio: { centerFreq: 923.118, sampleRate: 20000000 },
		activeVfoIndex: 0,
		rtk: { sources: [] as RtkStation[][], status: [], frequencies: [], frames: [] },
		showMsg: vi.fn(),
		isFreqInBandwidth: () => true,
		addRtkTrackingVfo: vi.fn(async (frequency: number, source: string) => {
			receiver.vfos.push({ ...makeDefaultVfo(frequency), rtk: true, rtkProfile: 'auto', rtkFollowSource: source });
		}),
	}) as unknown as AppInstance;
	return { receiver, scout: receiver.vfos[0] };
}

describe('scout and independent RTK tracking VFOs', () => {
	it('serializes repeated reports and keeps overlapping identities, selected VFO and receiver settings', async () => {
		const { receiver, scout } = setup();
		const bases = [station(), station(101), station(100, 'rtk2'), station(101, 'rtk2')];
		for (let i = 0; i < 5; i++) discoverFollowers(receiver, scout, bases);
		await flushPromises();
		expect(receiver.addRtkTrackingVfo).toHaveBeenCalledTimes(4);
		expect(new Set(receiver.vfos.slice(1).map((vfo) => vfo.rtkFollowSource)).size).toBe(4);
		expect(receiver.vfos.slice(1).every((vfo) => vfo.freq === 921.401 && !vfo.enabled)).toBe(true);
		expect(receiver.activeVfoIndex).toBe(0);
		expect(scout.rtkProfile).toBe('scan');
		expect(receiver.radio).toEqual({ centerFreq: 923.118, sampleRate: 20000000 });
	});
	it('reuses an existing follower and respects manually disabled or removed trackers', async () => {
		const { receiver, scout } = setup();
		receiver.vfos.push({ ...makeDefaultVfo(915.401), rtkProfile: 'auto', rtk: false, rtkFollowSource: 'rtk3-100-42' });
		discoverFollowers(receiver, scout, [station(), station(101)]);
		await flushPromises();
		expect(receiver.addRtkTrackingVfo).toHaveBeenCalledTimes(1);
		receiver.vfos.splice(2, 1);
		discoverFollowers(receiver, scout, [station(101)]);
		await flushPromises();
		expect(receiver.addRtkTrackingVfo).toHaveBeenCalledTimes(1);
	});
	it.each(['off', 'manual', 'removed', 'stopped', 'range-changed', 'remote'])(
		'cancels queued allocations when the scout is %s',
		async (reason) => {
			const { receiver, scout } = setup();
			discoverFollowers(receiver, scout, [station()]);
			if (reason === 'off') scout.rtkAutoTrack = false;
			if (reason === 'manual') scout.rtkProfile = 'rtk1';
			if (reason === 'removed') receiver.vfos = [];
			if (reason === 'stopped') receiver.running = false;
			if (reason === 'range-changed') scout.rtkScanEnd = 920;
			if (reason === 'remote') receiver.remoteMode = 'client';
			await flushPromises();
			expect(receiver.addRtkTrackingVfo).not.toHaveBeenCalled();
		},
	);
	it('bounds allocations and can fill a freed slot with an additional base', async () => {
		const { receiver, scout } = setup();
		const bases = Array.from({ length: 12 }, (_, i) => station(100 + i));
		discoverFollowers(receiver, scout, bases);
		await flushPromises();
		expect(receiver.vfos).toHaveLength(MAX_RTK_TRACKERS + 1);
		receiver.vfos.splice(1, 1);
		discoverFollowers(receiver, scout, bases);
		await flushPromises();
		expect(receiver.vfos).toHaveLength(MAX_RTK_TRACKERS + 1);
		expect(receiver.vfos.some((vfo) => vfo.rtkFollowSource === 'rtk3-100-42')).toBe(false);
	});
	it('merges scout sightings with current follower corrections into one station row', () => {
		const { receiver } = setup();
		const base = station();
		receiver.vfos.push({ ...makeDefaultVfo(921.401), rtkProfile: 'auto', rtk: true, rtkFollowSource: 'rtk3-100-42' });
		receiver.rtk.frequencies = [923.118, 921.401];
		receiver.rtk.status = [
			null,
			{
				state: 'receiving',
				message: 'Following',
				detectedProfile: 'rtk3',
				samples: 1,
				packets: 1,
				headers: 1,
				syncs: 1,
				crcErrors: 0,
				discontinuities: 0,
			},
		];
		receiver.rtk.sources = [[base], [{ ...base, discovery: undefined, rtcmCount: 10, lastCorrection: Date.now() }]];
		const rows = collectStations(receiver, Date.now());
		expect(rows).toHaveLength(1);
		expect(rows[0].indices).toEqual([0, 1]);
		expect(rows[0].station.rtcmCount).toBe(10);
		expect(rows[0].station.discovery?.hoppingObserved).toBe(true);
		expect(rows[0].reception.tone).toBe('live');
	});
});
