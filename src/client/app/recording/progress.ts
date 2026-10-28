import { computed, onBeforeUnmount, shallowRef, type Ref } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { IqCaptureProgress } from '@/worker/recording/types';
import { formatIqSize } from './sigmf';

export function useIqProgress(receiver: AppInstance, seconds: Ref<number>, status: Ref<string>, isCapturing: () => boolean) {
	const progress = shallowRef<IqCaptureProgress>();
	let polling = false,
		generation = 0;
	const clock = setInterval(() => {
		if (!isCapturing() || polling) return;
		polling = true;
		const current = generation;
		void receiver.backend
			.getIqCaptureProgress()
			.then((value) => {
				if (isCapturing() && current === generation && value) progress.value = value;
			})
			.catch(() => undefined)
			.finally(() => {
				polling = false;
			});
	}, 1000);
	onBeforeUnmount(() => clearInterval(clock));
	return {
		percent: computed(() => (progress.value ? (progress.value.capturedBytes / progress.value.totalBytes) * 100 : undefined)),
		reset() {
			generation++;
			progress.value = undefined;
		},
		status: computed(() => {
			const value = progress.value;
			if (!isCapturing() || !value) return status.value;
			const capturedSeconds = value.capturedBytes / 2 / receiver.radio.sampleRate;
			return `${value.capturedBytes === value.totalBytes ? 'Saving recording' : 'Recording'}… ${capturedSeconds.toFixed(1)} / ${seconds.value.toFixed(1)} s · ${formatIqSize(value.writtenBytes)} saved of ${formatIqSize(value.totalBytes)}`;
		}),
	};
}
