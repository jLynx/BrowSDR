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
		reset() {
			generation++;
			progress.value = undefined;
		},
		status: computed(() => {
			const value = progress.value;
			if (!isCapturing() || !value) return status.value;
			const capturedSeconds = value.capturedBytes / 2 / receiver.radio.sampleRate;
			return `Capturing raw IQ… ${capturedSeconds.toFixed(1)} / ${seconds.value.toFixed(1)} s · ${formatIqSize(value.writtenBytes)} written of ${formatIqSize(value.totalBytes)}`;
		}),
	};
}
