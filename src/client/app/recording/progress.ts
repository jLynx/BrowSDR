import { computed, onBeforeUnmount, shallowRef, type Ref } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { IqCaptureProgress } from '@/worker/recording/types';
import { formatIqSize } from './sigmf';

export function useIqProgress(
	receiver: AppInstance,
	seconds: Ref<number | null>,
	status: Ref<string>,
	isCapturing: () => boolean,
	stopping: Ref<boolean>,
) {
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
		percent: computed(() =>
			seconds.value !== null && progress.value?.totalBytes ? (progress.value.capturedBytes / progress.value.totalBytes) * 100 : undefined,
		),
		reset() {
			generation++;
			progress.value = undefined;
		},
		status: computed(() => {
			const value = progress.value;
			if (!isCapturing() || !value) return status.value;
			const capturedSeconds = value.capturedBytes / 2 / receiver.radio.sampleRate;
			if (value.phase === 'finalizing')
				return `Finalizing ${formatIqSize(value.writtenBytes)}… The browser is checking and committing the temporary file. Large recordings can take several minutes. Keep this tab open.`;
			if (value.phase === 'flushing' || stopping.value)
				return `Saving recording… ${formatIqSize(value.writtenBytes)} written of ${formatIqSize(value.capturedBytes)} captured`;
			if (seconds.value === null) return `Recording… ${capturedSeconds.toFixed(1)} s · ${formatIqSize(value.writtenBytes)} saved`;
			return `${value.capturedBytes === value.totalBytes ? 'Saving recording' : 'Recording'}… ${capturedSeconds.toFixed(1)} / ${seconds.value.toFixed(1)} s · ${formatIqSize(value.writtenBytes)} saved of ${formatIqSize(value.totalBytes ?? 0)}`;
		}),
	};
}
