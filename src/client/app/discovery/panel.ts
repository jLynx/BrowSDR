import { computed, defineComponent, inject, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { DiscoveryResult, DiscoverySignal } from '@/worker/discovery/types';
import * as components from '@/ui';
import { registerDiscovery } from './bridge';
import template from './panel.html?raw';
import { createAnalysis } from './analysis';
import { focusSpectrumFrequency } from '@/app/display/zoom';

export default defineComponent({
	name: 'DiscoveryPanel',
	components,
	template,
	setup() {
		const receiver = inject<AppInstance>('receiver')!;
		const result = shallowRef<DiscoveryResult>({ signals: [], binHz: 0, frames: 0, time: 0 });
		const selectedId = ref(0);
		const now = ref(Date.now());
		const error = ref('');
		const analysis = createAnalysis(
			receiver,
			(value) => {
				result.value = value;
			},
			() => {
				error.value = 'Signal analysis could not start. Clear history to retry.';
			},
		);
		const reset = () => {
			analysis.reset();
			selectedId.value = 0;
			result.value = { signals: [], binHz: 0, frames: 0, time: 0 };
			error.value = '';
		};
		const selected = computed(() => result.value.signals.find((signal) => signal.id === selectedId.value));
		const unregister = registerDiscovery(receiver, {
			selected: () => selected.value,
			submit: (data) => {
				if (!error.value) analysis.submit(data);
			},
		});
		const unwatch = watch(
			() => [
				receiver.radio.centerFreq,
				receiver.radio.sampleRate,
				receiver.radio.fftSize,
				receiver.discovery.thresholdDb,
				receiver.discovery.minWidthHz,
				receiver.discovery.excludeDc,
			],
			reset,
			{ flush: 'sync' },
		);
		const clock = setInterval(() => {
			if (receiver.discovery.panelOpen) now.value = Date.now();
		}, 1000);
		onBeforeUnmount(() => {
			unregister();
			unwatch();
			clearInterval(clock);
			analysis.reset();
		});
		const tune = async (newVfo: boolean) => {
			const signal = selected.value;
			if (!signal || !receiver.isFreqInBandwidth(signal.frequencyHz / 1e6)) return;
			try {
				if (newVfo) await receiver.addVfo();
				receiver.validateAndApplyVfoFreq(receiver.activeVfoIndex, signal.frequencyHz / 1e6);
				receiver.scrollSelectedVfoIntoView();
			} catch (cause) {
				receiver.showMsg(`Could not tune signal: ${String(cause)}`);
			}
		};
		return {
			receiver,
			result,
			selectedId,
			selected,
			error,
			reset,
			tune,
			selectSignal: (signal: DiscoverySignal) => {
				selectedId.value = signal.id;
				focusSpectrumFrequency(receiver, signal.frequencyHz / 1e6);
			},
			status: computed(() =>
				!receiver.running
					? 'Reception stopped'
					: receiver.discovery.enabled
						? 'Discovering across the full receive span'
						: 'Discovery paused',
			),
			resolution: computed(() => result.value.binHz || receiver.radio.sampleRate / receiver.radio.fftSize),
			width: (hz: number) => (hz < 1000 ? `${Math.round(hz)} Hz` : `${(hz / 1000).toFixed(1)} kHz`),
			age: (time: number) => `${Math.max(0, Math.floor((now.value - time) / 1000))}s ago`,
			active: (signal: DiscoverySignal) =>
				receiver.running && receiver.discovery.enabled && signal.active && now.value - signal.lastSeen < 1500,
		};
	},
});
