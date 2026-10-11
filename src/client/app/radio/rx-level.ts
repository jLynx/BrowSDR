import { defineComponent, inject, onUnmounted, ref, watch } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { RxLevel } from '@/radio/types';

/** Own the telemetry render effect so live levels do not rerender receiver controls. */
export default defineComponent({
	name: 'RxLevel',
	template: `<div v-if="supported" class="rx-level" aria-label="RX level">
		<template v-if="level">
			<div>RX peak {{ Math.min(100, 100 * Math.pow(10, level.peakDbfs / 20)).toFixed(0) }}%
				· {{ level.peakDbfs.toFixed(1) }} dBFS</div>
			<div>RMS {{ level.rmsDbfs.toFixed(1) }} dBFS
				· Near-clipped {{ (level.clippedFraction * 100).toFixed(3) }}%</div>
			<div :class="{ 'rx-level-warning': level.clippedFraction > 0.0001 || level.peakDbfs > -3 }">
				{{ level.clippedFraction > 0.0001 || level.peakDbfs > -3 ? 'ADC overload / low headroom — reduce gain' : 'ADC headroom available' }}</div>
		</template>
		<div v-else>{{ receiver.running ? 'RX level: waiting for samples' : 'RX level: reception stopped' }}</div>
		<div class="rx-level-hint">Sampled I/Q levels; not an RF input safety meter.</div>
	</div>`,
	setup() {
		const injected = inject<AppInstance>('receiver');
		if (!injected) throw new Error('RxLevel requires a receiver');
		const receiver: AppInstance = injected;
		const level = ref<RxLevel | null>(null);
		const supported = ref(false);
		let timer: ReturnType<typeof setInterval> | undefined;
		let generation = 0;
		let busy = false;
		async function poll() {
			if (busy) return;
			const current = generation;
			const backend = receiver.backend;
			busy = true;
			try {
				const value = await backend?.getRxLevel();
				if (current === generation) level.value = value && Date.now() - value.timestamp < 1000 ? value : null;
			} catch {
				if (current === generation) level.value = null;
			} finally {
				busy = false;
			}
		}
		watch(
			() => [receiver.running, receiver.radio.sampleRate, receiver.remoteMode, receiver.deviceCapabilities, receiver.gains['Receive Mode']],
			() => {
				generation++;
				level.value = null;
				clearInterval(timer);
				supported.value = receiver.remoteMode !== 'client' && ['hackrf', 'limesdr'].includes(receiver.deviceCapabilities?.deviceType ?? '');
				if (supported.value && receiver.running && receiver.gains['Receive Mode'] !== 1) timer = setInterval(() => void poll(), 250);
			},
			{ immediate: true },
		);
		onUnmounted(() => {
			generation++;
			clearInterval(timer);
		});
		return { receiver, level, supported };
	},
});
