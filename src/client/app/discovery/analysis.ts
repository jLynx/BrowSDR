import type { AppInstance } from '@/app/core/receiver.types';
import type { DiscoveryResult } from '@/worker/discovery/types';
import { rtkSurveyActive } from './rtk';

/** One transferable copy in flight; preserve the spectrum frame used by the display. */
export function createAnalysis(receiver: AppInstance, receive: (result: DiscoveryResult) => void, fail: () => void) {
	let worker: Worker | undefined;
	let pending = false;
	let lastFrame = 0;
	let lastRtkFrame = 0;
	let peaks: Float32Array | undefined;
	let band = '';
	return {
		reset() {
			worker?.terminate();
			worker = undefined;
			pending = false;
			lastFrame = 0;
			lastRtkFrame = 0;
			peaks = undefined;
			band = '';
		},
		submit(data: Float32Array) {
			const time = Date.now();
			const active = rtkSurveyActive(receiver);
			const key = `${receiver.radio.centerFreq}:${receiver.radio.sampleRate}:${data.length}`;
			if (!active || key !== band) peaks = undefined;
			band = key;
			if (active) {
				if (!peaks) peaks = data.slice();
				else for (let i = 0; i < data.length; i++) if (data[i] > peaks[i]) peaks[i] = data[i];
			}
			const rtk = active && time - lastRtkFrame >= 250;
			if ((!receiver.discovery.enabled && !rtk) || pending || time - lastFrame < 100) return;
			if (!worker) {
				worker = new Worker(new URL('../../worker/discovery/worker.ts', import.meta.url), { type: 'module' });
				worker.onmessage = (event: MessageEvent<DiscoveryResult>) => {
					pending = false;
					receive(event.data);
				};
				worker.onerror = () => {
					pending = false;
					fail();
				};
			}
			lastFrame = time;
			if (rtk) lastRtkFrame = time;
			pending = true;
			const copy = data.slice();
			const rtkData = rtk ? peaks : undefined;
			if (rtk) peaks = undefined;
			worker.postMessage(
				{
					data: copy,
					rtkData,
					time,
					discover: receiver.discovery.enabled,
					rtk,
					config: {
						centerHz: receiver.radio.centerFreq * 1e6,
						sampleRate: receiver.radio.sampleRate,
						thresholdDb: receiver.discovery.thresholdDb,
						minWidthHz: receiver.discovery.minWidthHz,
						excludeDc: receiver.discovery.excludeDc,
					},
				},
				[copy.buffer, ...(rtkData ? [rtkData.buffer] : [])],
			);
		},
	};
}
