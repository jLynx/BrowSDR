import type { AppInstance } from '@/app/core/receiver.types';
import type { DiscoveryResult } from '@/worker/discovery/types';

/** One transferable copy in flight; preserve the spectrum frame used by the display. */
export function createAnalysis(receiver: AppInstance, receive: (result: DiscoveryResult) => void, fail: () => void) {
	let worker: Worker | undefined;
	let pending = false;
	let lastFrame = 0;
	return {
		reset() {
			worker?.terminate();
			worker = undefined;
			pending = false;
			lastFrame = 0;
		},
		submit(data: Float32Array) {
			const time = Date.now();
			if (!receiver.discovery.enabled || pending || time - lastFrame < 100) return;
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
			pending = true;
			const copy = data.slice();
			worker.postMessage(
				{
					data: copy,
					time,
					config: {
						centerHz: receiver.radio.centerFreq * 1e6,
						sampleRate: receiver.radio.sampleRate,
						thresholdDb: receiver.discovery.thresholdDb,
						minWidthHz: receiver.discovery.minWidthHz,
						excludeDc: receiver.discovery.excludeDc,
					},
				},
				[copy.buffer],
			);
		},
	};
}
