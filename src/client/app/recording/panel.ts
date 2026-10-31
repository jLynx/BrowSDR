import { computed, defineComponent, inject, ref, watch } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import * as components from '@/ui';
import { recordingBytesPerSample, selectedIqBits } from '@/radio/iq/format';
import type { RecordingFormat } from '@/radio/iq/types';
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
		const precisionBits = computed(() => {
			const native = receiver.deviceCapabilities?.nativeIqBits;
			return native === 12 || native === 16 ? selectedIqBits(native, receiver.gains['IQ Precision'] ?? 0) : 8;
		});
		const format = ref<RecordingFormat>(precisionBits.value > 8 ? 'ci16_le' : 'ci8');
		watch(precisionBits, (bits) => {
			if (bits === 8) format.value = 'ci8';
		});
		const bytesPerSample = computed(() => recordingBytesPerSample(format.value));
		const seconds = computed(() => (mode.value === 'manual' ? null : duration.value * unit.value));
		const pickFile = (window as IqCaptureWindow).showSaveFilePicker?.bind(window);
		const byteLength = computed(() => {
			try {
				if (seconds.value === null) return IQ_MEMORY_LIMIT;
				return iqCaptureByteLength(receiver.radio.sampleRate, seconds.value, format.value);
			} catch {
				return 0;
			}
		});
		const saveToFile = computed(() => (seconds.value === null ? !!pickFile : byteLength.value > IQ_MEMORY_LIMIT));
		const blockedReason = computed(() => recordingBlockedReason(receiver, byteLength.value, !!pickFile, bytesPerSample.value));
		const { active, status, stopping, data, metadata, filename, backendCaptureStarted, progress, capture, stop, cancel } = useIqSession(
			receiver,
			seconds,
			saveToFile,
			blockedReason,
			pickFile,
			format,
			precisionBits,
		);
		return {
			receiver,
			format,
			precisionBits,
			bytesPerSample,
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
				seconds.value === null
					? `${formatIqSize(receiver.radio.sampleRate * bytesPerSample.value)} / second`
					: formatIqSize(byteLength.value),
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
