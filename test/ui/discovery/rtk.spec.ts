import { describe, expect, it, vi } from 'vitest';
import { analyseDiscoveryFrame } from '@/worker/discovery/analysis';
import { SignalTracker } from '@/worker/discovery/tracker';
import { rankRtkCandidates, feedRtkCandidates } from '@/app/discovery/rtk';
import type { AppInstance } from '@/app/core/receiver.types';

describe('shared signal analysis for RTK discovery', () => {
	it('finds custom 250/500 kHz channels while generic discovery is paused and ignores its width filter', () => {
		const data = new Float32Array(65536).fill(-100),
			config = { centerHz: 921.5e6, sampleRate: 20e6, thresholdDb: 20, minWidthHz: 600000, excludeDc: true };
		data.fill(-80, 20000, 20819);
		data.fill(-80, 42000, 43638);
		data.fill(-85, 50000, 50005);
		const result = analyseDiscoveryFrame({ data, config, time: Date.now(), discover: false, rtk: true }, new SignalTracker());
		expect(result.signals).toEqual([]);
		expect(result.rtk?.signals).toHaveLength(3);
		const ranked = rankRtkCandidates(result.rtk!.signals);
		expect(ranked).toHaveLength(3);
		expect(ranked.slice(0, 2)).toEqual(expect.arrayContaining([917.728, 924.567]));
		const send = vi.fn();
		const receiver = {
			running: true,
			remoteMode: 'none',
			vfos: [{ rtk: true, rtkProfile: 'scan' }],
			radio: { centerFreq: 921.5, sampleRate: 20e6 },
			backend: { setRtkDiscoveryCandidates: send },
		} as unknown as AppInstance;
		feedRtkCandidates(receiver, result);
		expect(send).toHaveBeenCalledWith(ranked, 921.5, 20e6);
		feedRtkCandidates(receiver, { ...result, time: result.time - 3000 });
		receiver.vfos[0].rtkScanStart = 917;
		receiver.vfos[0].rtkScanEnd = 918;
		feedRtkCandidates(receiver, result);
		expect(send).toHaveBeenLastCalledWith([917.728], 921.5, 20e6);
		receiver.radio.centerFreq = 922;
		feedRtkCandidates(receiver, result);
		expect(send).toHaveBeenCalledTimes(2);
	});
	it('treats widths as hints and drops artifacts without claiming an RTK identity', () => {
		expect(
			rankRtkCandidates([
				{ frequencyHz: 919e6, widthHz: 3000, aboveNoiseDb: 20 },
				{ frequencyHz: 920e6, widthHz: 250000, aboveNoiseDb: 18 },
				{ frequencyHz: 920.001e6, widthHz: 250000, aboveNoiseDb: 17 },
				{ frequencyHz: 921e6, widthHz: 1000000, aboveNoiseDb: 40 },
				{ frequencyHz: NaN, widthHz: 250000, aboveNoiseDb: 40 },
			]),
		).toEqual([920, 919]);
	});
});
