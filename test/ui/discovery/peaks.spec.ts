import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnalysis } from '@/app/discovery/analysis';
import { analyseDiscoveryFrame } from '@/worker/discovery/analysis';
import { SignalTracker } from '@/worker/discovery/tracker';
import type { DiscoveryFrame, DiscoveryResult } from '@/worker/discovery/types';
import type { AppInstance } from '@/app/core/receiver.types';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('RTK burst retention between spectrum analyses', () => {
	it('keeps short bursts through silence without changing the generic spectrum, and clears them on retune', () => {
		const workers: FakeWorker[] = [];
		class FakeWorker {
			onmessage?: (event: { data: DiscoveryResult }) => void;
			postMessage = vi.fn<(frame: DiscoveryFrame, transfer: ArrayBuffer[]) => void>();
			terminate = vi.fn();
			constructor() {
				workers.push(this);
			}
		}
		vi.stubGlobal('Worker', FakeWorker);
		let time = 1000;
		vi.spyOn(Date, 'now').mockImplementation(() => time);
		const receiver = {
			running: true,
			remoteMode: 'none',
			vfos: [{ rtk: true, rtkProfile: 'scan' }],
			radio: { centerFreq: 921.5, sampleRate: 20e6 },
			discovery: { enabled: false, thresholdDb: 20, minWidthHz: 600000, excludeDc: true },
		} as unknown as AppInstance;
		const analysis = createAnalysis(
				receiver,
				() => {},
				() => {},
			),
			silence = new Float32Array(8192).fill(-100);
		analysis.submit(silence);
		workers[0].onmessage!({ data: { signals: [], binHz: 1, frames: 0, time } });
		time += 50;
		const burst = silence.slice();
		burst.fill(-75, 2000, 2102);
		analysis.submit(burst);
		expect(workers[0].postMessage).toHaveBeenCalledTimes(1);
		time += 200;
		analysis.submit(silence);
		const frame = workers[0].postMessage.mock.calls[1][0];
		expect(frame.data[2050]).toBe(-100);
		expect(frame.rtkData![2050]).toBe(-75);
		expect(burst[2050]).toBe(-75);
		const result = analyseDiscoveryFrame(frame, new SignalTracker());
		expect(result.signals).toEqual([]);
		expect(result.rtk!.signals).toHaveLength(1);
		workers[0].onmessage!({ data: result });
		time += 50;
		analysis.submit(burst);
		receiver.radio.centerFreq = 922;
		time += 200;
		analysis.submit(silence);
		expect(workers[0].postMessage.mock.calls[2][0].rtkData![2050]).toBe(-100);
		analysis.reset();
		expect(workers[0].terminate).toHaveBeenCalledOnce();
	});
});
