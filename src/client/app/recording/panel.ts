import { computed, defineComponent, inject, onBeforeUnmount, ref, shallowRef } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import * as components from '@/ui';
import { IQ_MEMORY_LIMIT, iqCaptureByteLength } from '@/worker/recording/limits';
import type { IqCaptureWindow } from './types';
import { formatIqSize, sigmfMetadata } from './sigmf';
import { useIqProgress } from './progress';
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
			active = ref(false);
		const status = ref('Capture the full received band before demodulation.');
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
		const blockedReason = computed(() => {
			if (!byteLength.value) return 'Choose a positive capture duration.';
			if (!receiver.running) return 'Start reception before capturing IQ.';
			if (receiver.remoteMode === 'client') return 'IQ capture requires a locally connected receiver.';
			if (receiver.autoGain.active) return 'Stop automatic gain adjustment before capturing IQ.';
			if (saveToFile.value && !pickFile)
				return `This capture exceeds the 64 MiB memory limit. Use Chrome or Edge to save directly to a file, or choose at most ${(IQ_MEMORY_LIMIT / receiver.radio.sampleRate / 2).toFixed(2)} seconds.`;
			return '';
		});
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
				status.value = saveToFile.value ? 'Choose where to save the IQ file…' : 'Capturing raw IQ…';
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
				status.value = 'Capturing raw IQ…';
				backendCaptureStarted.value = true;
				const result = file ? await receiver.backend.captureIqToFile(seconds.value, file) : await receiver.backend.captureIq(seconds.value);
				const length = 'data' in result ? result.data.length : result.byteLength;
				if ('data' in result) data.value = result.data;
				metadata.value = sigmfMetadata(radio, gains, started, result.missingSamples);
				const gaps = result.missingSamples;
				status.value = `${(length / 2 / radio.sampleRate).toFixed(3)} s captured · ${gaps === null ? 'USB continuity unavailable' : `${gaps} missing USB samples`}. ${file ? 'IQ file saved. Download the matching metadata.' : 'Download both files with matching names.'}`;
			} catch (error) {
				status.value = error instanceof DOMException && error.name === 'AbortError' ? 'File selection cancelled.' : String(error);
			} finally {
				backendCaptureStarted.value = false;
				progress.reset();
				active.value = false;
			}
		}
		function cancel() {
			if (!active.value) return;
			cancelled = true;
			status.value = 'IQ capture cancelled.';
			if (backendCaptureStarted.value)
				void receiver.backend.cancelIqCapture().catch((error: unknown) => {
					status.value = String(error);
				});
		}
		onBeforeUnmount(cancel);
		return {
			receiver,
			duration,
			unit,
			active,
			status: computed(() => (active.value ? progress.status.value : blockedReason.value || status.value)),
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
