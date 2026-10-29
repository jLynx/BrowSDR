import { computed, defineComponent, inject, ref } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import * as components from '@/ui';
import { IQ_MEMORY_LIMIT, iqCaptureByteLength } from '@/worker/recording/limits';
import type { IqCaptureWindow } from './types';
import { formatIqSize } from './sigmf';
import { useIqSession } from './session';
import { recordingBlockedReason } from './messages';
import template from './panel.html?raw';

function download(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default defineComponent({
	name: 'IqCapturePanel',
	template,
	components,
	setup() {
		const receiver = inject<AppInstance>('receiver')!;
		const duration = ref(5),
			unit = ref(1);
		const mode = ref('timed');
		const seconds = computed(() => (mode.value === 'manual' ? null : duration.value * unit.value));
		const pickFile = (window as IqCaptureWindow).showSaveFilePicker?.bind(window);
		const byteLength = computed(() => {
			try {
				if (seconds.value === null) return IQ_MEMORY_LIMIT;
				return iqCaptureByteLength(receiver.radio.sampleRate, seconds.value);
			} catch {
				return 0;
			}
		});
		const saveToFile = computed(() => (seconds.value === null ? !!pickFile : byteLength.value > IQ_MEMORY_LIMIT));
		const blockedReason = computed(() => recordingBlockedReason(receiver, byteLength.value, !!pickFile));
		const { active, status, stopping, data, metadata, filename, backendCaptureStarted, progress, capture, stop, cancel } = useIqSession(
			receiver,
			seconds,
			saveToFile,
			blockedReason,
			pickFile,
		);
		return {
			receiver,
			duration,
			unit,
			mode,
			stopping,
			backendCaptureStarted,
			active,
			status: computed(() => (active.value ? progress.status.value : metadata.value ? status.value : blockedReason.value || status.value)),
			progressPercent: progress.percent,
			blockedReason,
			data,
			metadata,
			saveToFile,
			size: computed(() =>
				seconds.value === null ? `${formatIqSize(receiver.radio.sampleRate * 2)} / second` : formatIqSize(byteLength.value),
			),
			capture,
			stop,
			cancel,
			downloadData: () => {
				if (data.value) download(new Blob([data.value]), `${filename.value}.sigmf-data`);
			},
			downloadMetadata: () => download(new Blob([metadata.value], { type: 'application/json' }), `${filename.value}.sigmf-meta`),
		};
	},
});
