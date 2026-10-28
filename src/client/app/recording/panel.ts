import { computed, defineComponent, inject, onBeforeUnmount, ref, shallowRef, toRef } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import * as components from '@/ui';
import { IQ_MEMORY_LIMIT, iqCaptureByteLength } from '@/worker/recording/limits';
import type { IqCaptureWindow } from './types';
import { formatIqSize, sigmfMetadata } from './sigmf';
import { useIqProgress } from './progress';
import { recordingBlockedReason, recordingComplete } from './messages';
import { errorMessage } from '@/platform/errors';
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
			unit = ref(1),
			active = toRef(receiver.iqRecording, 'active');
		const status = ref('Ready to record.');
		const seconds = computed(() => duration.value * unit.value);
		const pickFile = (window as IqCaptureWindow).showSaveFilePicker?.bind(window);
		const data = shallowRef<Int8Array<ArrayBuffer>>();
		const metadata = ref(''),
			filename = ref('');
		const byteLength = computed(() => {
			try {
				return iqCaptureByteLength(receiver.radio.sampleRate, seconds.value);
			} catch {
				return 0;
			}
		});
		const saveToFile = computed(() => byteLength.value > IQ_MEMORY_LIMIT);
		const blockedReason = computed(() => recordingBlockedReason(receiver, byteLength.value, !!pickFile));
		let cancelled = false;
		const backendCaptureStarted = ref(false);
		const progress = useIqProgress(receiver, seconds, status, () => backendCaptureStarted.value);
		async function capture() {
			if (active.value || blockedReason.value) return;
			active.value = true;
			cancelled = false;
			progress.reset();
			try {
				const suggestedName = `browsdr-${receiver.radio.centerFreq.toFixed(6)}MHz-${new Date().toISOString().replace(/[:.]/g, '-')}`;
				status.value = saveToFile.value ? 'Choose where to save your recording…' : 'Recording…';
				const file =
					saveToFile.value && pickFile
						? await pickFile({
								suggestedName: `${suggestedName}.sigmf-data`,
							})
						: undefined;
				if (cancelled) return;
				if (blockedReason.value) throw new Error(blockedReason.value);
				const started = new Date().toISOString();
				const radio = { ...receiver.radio },
					gains = { ...receiver.gains };
				data.value = undefined;
				metadata.value = '';
				filename.value = file ? file.name.replace(/\.sigmf-data$/, '') : suggestedName;
				status.value = 'Recording…';
				backendCaptureStarted.value = true;
				const result = file ? await receiver.backend.captureIqToFile(seconds.value, file) : await receiver.backend.captureIq(seconds.value);
				const length = 'data' in result ? result.data.length : result.byteLength;
				if ('data' in result) data.value = result.data;
				metadata.value = sigmfMetadata(radio, gains, started, result.missingSamples);
				status.value = recordingComplete(length, radio.sampleRate, result.missingSamples, !!file);
			} catch (error) {
				status.value = cancelled
					? 'Recording cancelled.'
					: error instanceof DOMException && error.name === 'AbortError'
						? 'File selection cancelled.'
						: errorMessage(error);
			} finally {
				backendCaptureStarted.value = false;
				progress.reset();
				active.value = false;
			}
		}
		function cancel() {
			if (!active.value) return;
			cancelled = true;
			status.value = 'Recording cancelled.';
			if (backendCaptureStarted.value)
				void receiver.backend.cancelIqCapture().catch((error: unknown) => {
					status.value = errorMessage(error);
				});
		}
		onBeforeUnmount(cancel);
		return {
			receiver,
			duration,
			unit,
			active,
			status: computed(() => (active.value ? progress.status.value : metadata.value ? status.value : blockedReason.value || status.value)),
			progressPercent: progress.percent,
			blockedReason,
			data,
			metadata,
			saveToFile,
			size: computed(() => formatIqSize(byteLength.value)),
			capture,
			cancel,
			downloadData: () => {
				if (data.value) download(new Blob([data.value]), `${filename.value}.sigmf-data`);
			},
			downloadMetadata: () => download(new Blob([metadata.value], { type: 'application/json' }), `${filename.value}.sigmf-meta`),
		};
	},
});
