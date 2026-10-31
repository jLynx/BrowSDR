import { describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { computed, reactive } from 'vue';
import { File as NodeFile } from 'node:buffer';
import { makeDefaultVfo } from '@/app/core/constants';
import { createAppData } from '@/app/core/state';
import { clearDecoderSources } from '@/app/core/decoder-state';
import type { AppInstance } from '@/app/core/receiver.types';
import type { RtkStation } from '@/worker/decoders/rtk/types';
import { discoverFollowers } from '@/app/decoders/rtk/discovery/followers';
import { useDiscoveryControls } from '@/app/decoders/rtk/discovery-controls';
import { collectStations } from '@/app/decoders/rtk/stations';
import { replayMethods } from '@/app/replay/connection';

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
		...createAppData(),
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
	it('automatically tracks more than eight bases without duplicates', async () => {
		const { receiver, scout } = setup();
		const bases = Array.from({ length: 12 }, (_, i) => station(100 + i));
		discoverFollowers(receiver, scout, bases);
		await flushPromises();
		expect(receiver.vfos).toHaveLength(13);
		expect(new Set(receiver.vfos.slice(1).map((vfo) => vfo.rtkFollowSource)).size).toBe(12);
		receiver.vfos.splice(1, 1);
		discoverFollowers(receiver, scout, bases);
		await flushPromises();
		expect(receiver.vfos).toHaveLength(12);
		expect(receiver.vfos.some((vfo) => vfo.rtkFollowSource === 'rtk3-100-42')).toBe(false);
	});
	it('can manually add a tracker after more than eight have already been allocated', async () => {
		const { receiver, scout } = setup();
		discoverFollowers(
			receiver,
			scout,
			Array.from({ length: 12 }, (_, i) => station(100 + i)),
		);
		await flushPromises();
		scout.rtkAutoTrack = false;
		receiver.rtk.sources[0] = [station(200)];
		receiver.rtk.frequencies[0] = scout.freq;
		const entry = computed(() => collectStations(receiver, Date.now())[0]);
		await useDiscoveryControls(receiver, entry).followDiscovered();
		expect(receiver.vfos).toHaveLength(14);
		expect(receiver.vfos[13].rtkFollowSource).toBe('rtk3-200-42');
		expect(receiver.activeVfoIndex).toBe(13);
	});
	it('rediscovers removed trackers on a fresh input stream with the same range and keeps disabled trackers', async () => {
		const { receiver, scout } = setup();
		const bases = [station(), station(101), station(102)];
		discoverFollowers(receiver, scout, bases);
		await flushPromises();
		receiver.vfos[1].rtk = false;
		receiver.vfos.splice(2);
		discoverFollowers(receiver, scout, bases);
		await flushPromises();
		expect(receiver.vfos).toHaveLength(2);
		clearDecoderSources(receiver);
		discoverFollowers(receiver, scout, bases);
		await flushPromises();
		expect(receiver.vfos).toHaveLength(4);
		expect(receiver.vfos[1].rtk).toBe(false);
		expect(receiver.addRtkTrackingVfo).toHaveBeenCalledTimes(5);
		expect(receiver.activeVfoIndex).toBe(0);
	});
	it('invalidates queued discoveries from the previous stream', async () => {
		const { receiver, scout } = setup();
		discoverFollowers(receiver, scout, [station()]);
		clearDecoderSources(receiver);
		discoverFollowers(receiver, scout, [station(101)]);
		await flushPromises();
		expect(receiver.addRtkTrackingVfo).toHaveBeenCalledTimes(1);
		expect(receiver.vfos[1].rtkFollowSource).toBe('rtk3-101-42');
	});
	it('keeps in-flight allocations serialized across a stream reset', async () => {
		const { receiver, scout } = setup();
		let finish!: () => void;
		vi.mocked(receiver.addRtkTrackingVfo).mockImplementationOnce(async (frequency, source) => {
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			receiver.vfos.push({ ...makeDefaultVfo(frequency), rtk: true, rtkProfile: 'auto', rtkFollowSource: source });
		});
		discoverFollowers(receiver, scout, [station()]);
		await flushPromises();
		clearDecoderSources(receiver);
		discoverFollowers(receiver, scout, [station(), station(101)]);
		await flushPromises();
		expect(receiver.addRtkTrackingVfo).toHaveBeenCalledTimes(1);
		finish();
		await flushPromises();
		expect(receiver.addRtkTrackingVfo).toHaveBeenCalledTimes(2);
		expect(receiver.vfos).toHaveLength(3);
	});
	it('recreates removed trackers after reloading the very same IQ recording', async () => {
		const { receiver, scout } = setup();
		const recording = {
			file: new NodeFile([new Uint8Array(2)], 'test.iq') as unknown as File,
			sampleRate: 20000000,
			centerHz: 923118000,
			frequencyShiftHz: 0,
		};
		receiver.iqReplay = { recording, progress: { state: 'playing', seconds: 0, duration: 1, delaySeconds: 0 } };
		receiver._togglePlay = vi.fn(async () => {
			receiver.running = false;
		});
		receiver.backend = {
			replaceIqReplay: vi.fn(async () => {}),
			getDeviceCapabilities: vi.fn(async () => ({
				deviceType: 'iq-replay',
				sampleRates: [20000000],
				gainControls: [],
				sampleFormat: 'int8',
			})),
			info: vi.fn(async () => ({ name: 'IQ File Replay' })),
		} as unknown as AppInstance['backend'];
		const bases = [station(), station(101)];
		discoverFollowers(receiver, scout, bases);
		await flushPromises();
		receiver.vfos.splice(1);
		await replayMethods.replaceIqReplay.call(receiver, recording);
		expect(receiver.vfos).toHaveLength(1);
		receiver.running = true;
		discoverFollowers(receiver, scout, bases);
		await flushPromises();
		expect(receiver.vfos).toHaveLength(3);
		expect(receiver.addRtkTrackingVfo).toHaveBeenCalledTimes(4);
		expect(scout.rtkProfile).toBe('scan');
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
