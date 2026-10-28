import { onBeforeUnmount, ref, shallowRef, toRef, type Ref } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { IqCaptureWindow } from './types';
import { sigmfMetadata } from './sigmf';
import { recordingComplete } from './messages';
import { useIqProgress } from './progress';
import { errorMessage, errorName } from '@/platform/errors';

export function useIqSession(
	receiver: AppInstance,
	seconds: Ref<number | null>,
	saveToFile: Ref<boolean>,
	blockedReason: Ref<string>,
	pickFile: IqCaptureWindow['showSaveFilePicker'],
) {
	const active = toRef(receiver.iqRecording, 'active');
	const status = ref('Ready to record.'),
		stopping = ref(false);
	const data = shallowRef<Int8Array<ArrayBuffer>>();
	const metadata = ref(''),
		filename = ref('');
	let cancelled = false;
	const backendCaptureStarted = ref(false);
	const progress = useIqProgress(receiver, seconds, status, () => backendCaptureStarted.value, stopping);
	async function capture() {
		if (active.value || blockedReason.value) return;
		active.value = true;
		cancelled = false;
		stopping.value = false;
		progress.reset();
		let recoveryMetadata = '';
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
			recoveryMetadata = sigmfMetadata(radio, gains, started, null);
			const result = file ? await receiver.backend.captureIqToFile(seconds.value, file) : await receiver.backend.captureIq(seconds.value);
			const length = 'data' in result ? result.data.length : result.byteLength;
			if ('data' in result) data.value = result.data;
			metadata.value = sigmfMetadata(radio, gains, started, result.missingSamples);
			status.value = recordingComplete(length, radio.sampleRate, result.missingSamples, !!file);
		} catch (error) {
			if (!cancelled && errorName(error) === 'IqFileFinalizeError') metadata.value = recoveryMetadata;
			status.value = cancelled
				? 'Recording cancelled.'
				: error instanceof DOMException && error.name === 'AbortError'
					? 'File selection cancelled.'
					: errorMessage(error);
		} finally {
			backendCaptureStarted.value = false;
			progress.reset();
			active.value = false;
			stopping.value = false;
		}
	}
	function stop() {
		if (!active.value || !backendCaptureStarted.value || stopping.value) return;
		stopping.value = true;
		status.value = 'Saving recording…';
		void receiver.backend.stopIqCapture().catch((error: unknown) => {
			stopping.value = false;
			status.value = errorMessage(error);
		});
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
	return { active, status, stopping, data, metadata, filename, backendCaptureStarted, progress, capture, stop, cancel };
}
