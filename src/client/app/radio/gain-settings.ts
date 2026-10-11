import { defineComponent, inject, computed } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { DeviceCapabilities, GainControl } from '@/radio/types';
import { UiButton, UiIcon } from '@/ui';

export function restoreDeviceGains(caps: DeviceCapabilities, saved: Record<string, number>) {
	return Object.fromEntries(
		caps.gainControls.map((gc) => {
			const value = saved[gc.name];
			const valid =
				Number.isFinite(value) &&
				value >= gc.min &&
				value <= gc.max &&
				(gc.step <= 0 || Math.abs((value - gc.min) / gc.step - Math.round((value - gc.min) / gc.step)) < 1e-6);
			return [gc.name, gc.name !== 'Receive Mode' && valid ? value : gc.default];
		}),
	);
}

function isGain(control: GainControl) {
	return !['Antenna', 'RX Channel', 'USB Format', 'Receive Mode'].includes(control.name);
}

export default defineComponent({
	name: 'GainReset',
	components: { UiButton, UiIcon },
	template: `<UiButton v-if="changed" variant="secondary" class="gain-reset" :disabled="receiver.autoGain.active"
		@click="reset" title="Reset all gains to defaults" aria-label="Reset gains"><UiIcon name="reset" :size="16" /></UiButton>`,
	setup() {
		const receiver = inject<AppInstance>('receiver');
		if (!receiver) throw new Error('GainReset requires a receiver');
		const controls = computed(() => receiver.deviceCapabilities?.gainControls?.filter(isGain) ?? []);
		return {
			receiver,
			changed: computed(() => receiver.remoteMode !== 'client' && controls.value.some((gc) => receiver.gains[gc.name] !== gc.default)),
			reset() {
				if (receiver.autoGain.active || receiver.remoteMode === 'client') return;
				for (const gc of controls.value) receiver.gains[gc.name] = gc.default;
			},
		};
	},
});
