import { computed, defineComponent, inject, onBeforeUnmount, ref, shallowRef } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import * as components from '@/ui';
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
		const seconds = ref(5),
			active = ref(false),
			status = ref('Capture the full received band before demodulation.');
		const data = shallowRef<Int8Array<ArrayBuffer>>();
		const metadata = ref(''),
			filename = ref('');
		const size = computed(() => (seconds.value * receiver.radio.sampleRate * 2) / 1024 / 1024);
		async function capture() {
			if (active.value) return;
			active.value = true;
			data.value = undefined;
			status.value = 'Capturing raw IQ…';
			const started = new Date().toISOString();
			const radio = { ...receiver.radio },
				gains = { ...receiver.gains };
			try {
				const result = await receiver.backend.captureIq(seconds.value);
				data.value = result.data;
				filename.value = `browsdr-${radio.centerFreq.toFixed(6)}MHz-${started.replace(/[:.]/g, '-')}`;
				metadata.value = JSON.stringify(
					{
						global: {
							'core:datatype': 'ci8',
							'core:sample_rate': radio.sampleRate,
							'core:version': '1.2.6',
							'core:recorder': 'BrowSDR',
							'core:description': 'Raw signed I/Q; I first, Q second. Full receiver bandwidth.',
							'browsdr:gains': gains,
							'browsdr:frequency_shift_hz': radio.frequencyShift * 1e6,
							'browsdr:missing_samples': result.missingSamples,
						},
						captures: [
							{ 'core:sample_start': 0, 'core:frequency': (radio.centerFreq - radio.frequencyShift) * 1e6, 'core:datetime': started },
						],
						annotations: [],
					},
					null,
					2,
				);
				const gaps = result.missingSamples;
				status.value = `${(result.data.length / 2 / radio.sampleRate).toFixed(3)} s captured · ${gaps === null ? 'USB continuity unavailable' : `${gaps} missing USB samples`}. Download both files with matching names.`;
			} catch (error) {
				status.value = String(error);
			} finally {
				active.value = false;
			}
		}
		function cancel() {
			if (active.value) void receiver.backend.cancelIqCapture();
		}
		onBeforeUnmount(cancel);
		return {
			receiver,
			seconds,
			active,
			status,
			data,
			size,
			capture,
			cancel,
			downloadData: () => {
				if (data.value) download(new Blob([data.value]), `${filename.value}.sigmf-data`);
			},
			downloadMetadata: () => download(new Blob([metadata.value], { type: 'application/json' }), `${filename.value}.sigmf-meta`),
		};
	},
});
