import { defineComponent, inject } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import { autoContrastRange } from '@/display/contrast';
import { DEFAULT_SPECTRUM_RANGE } from '@/display/spectrum-range';
import { UiFormRow, UiSlider, UiButton } from '@/ui';

export default defineComponent({
	name: 'ContrastControls',
	components: { UiFormRow, UiSlider, UiButton },
	template: `<div class="contrast-controls">
		<UiFormRow>
			<UiButton variant="secondary" @click="setAutoContrast" :disabled="!receiver.running"
				title="Set contrast from the current spectrum once, then hold it. Does not change reception gains.">Auto set contrast</UiButton>
		</UiFormRow>
		<UiFormRow>
			<UiButton variant="secondary" @click="resetContrast"
				title="Restore the original spectrum and waterfall display range. Does not change reception gains.">Reset contrast</UiButton>
		</UiFormRow>
		<UiFormRow><label>Waterfall Min</label>
			<UiSlider :model-value="receiver.display.minDB" @update:model-value="setMinimum"
				:min="-200" :max="-1"
				input-label="Waterfall minimum" :value-text="receiver.display.minDB.toFixed(0) + ' dB'" />
		</UiFormRow>
		<UiFormRow><label>Waterfall Max</label>
			<UiSlider :model-value="receiver.display.maxDB" @update:model-value="setMaximum"
				:min="-199" :max="0"
				input-label="Waterfall maximum" :value-text="receiver.display.maxDB.toFixed(0) + ' dB'" />
		</UiFormRow>
		<p class="rx-level-hint">Sets display contrast once, then holds it. Also applies to the spectrum; does not change gains.</p>
	</div>`,
	setup() {
		const receiver = inject<AppInstance>('receiver');
		if (!receiver) throw new Error('ContrastControls requires a receiver');
		return {
			receiver,
			resetContrast() {
				Object.assign(receiver.display, DEFAULT_SPECTRUM_RANGE);
			},
			setAutoContrast() {
				if (!receiver.running || !receiver._lastSpectrumData) return;
				const range = autoContrastRange(receiver._lastSpectrumData);
				if (range) Object.assign(receiver.display, range);
			},
			setMinimum(value: number) {
				if (Number.isFinite(value)) receiver.display.minDB = Math.max(-200, Math.min(value, receiver.display.maxDB - 1));
			},
			setMaximum(value: number) {
				if (Number.isFinite(value)) receiver.display.maxDB = Math.min(0, Math.max(value, receiver.display.minDB + 1));
			},
		};
	},
});
