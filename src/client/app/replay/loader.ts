import { defineComponent, inject, ref, computed, markRaw } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { IqRecording } from '@/radio/iq-replay/types';
import { recordingFromSigmf, validateIqRecording } from '@/radio/iq-replay/metadata';
import { errorMessage } from '@/platform/errors';
import { UiDialog, UiButton, UiFormRow, UiInput, UiInputGroup } from '@/ui';
import template from './loader.html?raw';

export default defineComponent({
	components: { UiDialog, UiButton, UiFormRow, UiInput, UiInputGroup },
	template,
	setup() {
		const receiver = inject<AppInstance>('receiver')!;
		const recording = ref<IqRecording | null>(null);
		const rate = ref(20),
			center = ref(100),
			shift = ref(0);
		const error = ref(''),
			busy = ref(false),
			metadataLoaded = ref(false);
		const select = async (event: Event) => {
			const input = event.target as HTMLInputElement;
			const files = Array.from(input.files ?? []);
			const data = files.filter((file) => file.name.endsWith('.sigmf-data') || file.name.endsWith('.iq'));
			const meta = files.filter((file) => /\.sigmf-meta(?:\.json)?$/i.test(file.name));
			error.value = '';
			recording.value = null;
			metadataLoaded.value = false;
			try {
				if (data.length !== 1 || meta.length > 1) throw new Error('Select one IQ data file and its matching SigMF metadata together.');
				const file = data[0];
				if (meta.length && file.name.replace(/\.(sigmf-data|iq)$/i, '') !== meta[0].name.replace(/\.sigmf-meta(?:\.json)?$/i, ''))
					throw new Error('The IQ data and metadata filenames must match.');
				if (meta[0]?.size > 1024 * 1024) throw new Error('SigMF metadata must be smaller than 1 MiB.');
				const value = meta.length
					? recordingFromSigmf(file, await meta[0].text())
					: { file, sampleRate: rate.value * 1e6, centerHz: center.value * 1e6, frequencyShiftHz: shift.value * 1e6 };
				rate.value = value.sampleRate / 1e6;
				center.value = value.centerHz / 1e6;
				shift.value = value.frequencyShiftHz / 1e6;
				metadataLoaded.value = meta.length > 0;
				recording.value = markRaw(value);
			} catch (cause) {
				error.value = errorMessage(cause);
			}
			input.value = '';
		};
		const load = async () => {
			if (!recording.value || busy.value) return;
			busy.value = true;
			error.value = '';
			try {
				const value = {
					...recording.value,
					sampleRate: rate.value * 1e6,
					centerHz: center.value * 1e6,
					frequencyShiftHz: shift.value * 1e6,
				};
				validateIqRecording(value);
				if (receiver.iqReplayReplace) await receiver.replaceIqReplay(value);
				else await receiver.connectIqReplay(value);
				recording.value = null;
			} catch (cause) {
				error.value = errorMessage(cause);
			} finally {
				busy.value = false;
			}
		};
		return {
			receiver,
			recording,
			rate,
			center,
			shift,
			error,
			busy,
			metadataLoaded,
			select,
			load,
			duration: computed(() => (recording.value && rate.value > 0 ? recording.value.file.size / 2 / (rate.value * 1e6) : 0)),
		};
	},
});
