import { ref } from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, within } from 'storybook/test';
import { UiInput, UiSelect, UiCheckbox, UiRadio, UiFormRow, UiInputGroup, UiSlider, UiSpinbox } from '..';

const components = { UiInput, UiSelect, UiCheckbox, UiRadio, UiFormRow, UiInputGroup, UiSlider, UiSpinbox };
const meta = { title: 'UI/Controls', component: UiInput, tags: ['autodocs'] } satisfies Meta<typeof UiInput>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Text: Story = {
	render: () => ({
		components,
		setup: () => ({ value: ref('FM station') }),
		template: '<UiInput v-model="value" class="bookmark-dialog-input" aria-label="Bookmark name" />',
	}),
};
export const Numeric: Story = {
	render: () => ({
		components,
		setup: () => ({ value: ref(100) }),
		template:
			'<UiFormRow label="Center" input-id="center"><UiInputGroup unit="MHz"><UiInput id="center" v-model.number="value" type="number" step="0.1" /></UiInputGroup><output>{{ typeof value }}: {{ value }}</output></UiFormRow>',
	}),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.clear(canvas.getByRole('spinbutton'));
		await userEvent.type(canvas.getByRole('spinbutton'), '106.5');
		await expect(canvas.getByRole('status')).toHaveTextContent('number: 106.5');
	},
};
export const Select: Story = {
	render: () => ({
		components,
		setup: () => ({ value: ref(2000000) }),
		template:
			'<UiFormRow label="Sample Rate" input-id="sample"><UiSelect id="sample" v-model.number="value"><option value="2000000">2 MSPS</option><option value="20000000">20 MSPS</option></UiSelect><output>{{ typeof value }}: {{ value }}</output></UiFormRow>',
	}),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.selectOptions(canvas.getByRole('combobox'), '20000000');
		await expect(canvas.getByRole('status')).toHaveTextContent('number: 20000000');
	},
};
export const Checkboxes: Story = {
	render: () => ({
		components,
		setup: () => ({ checked: ref(false), enabled: ref(true) }),
		template:
			'<div style="display:flex;gap:16px"><UiCheckbox v-model="checked" label="Squelch"/><UiCheckbox v-model="enabled" label="Stereo"/><UiCheckbox :model-value="false" disabled label="Disabled"/><UiCheckbox :model-value="true" disabled label="Disabled checked"/></div>',
	}),
	play: async ({ canvasElement }) => {
		const checkbox = within(canvasElement).getByRole('checkbox', { name: 'Squelch' });
		await userEvent.click(checkbox);
		await expect(checkbox).toBeChecked();
	},
};
export const NativeCheckbox: Story = {
	render: () => ({
		components,
		setup: () => ({ gain: ref(0) }),
		template: '<UiCheckbox variant="native" v-model="gain" :true-value="1" :false-value="0" label="Amp (14dB)"/>',
	}),
};
export const Modes: Story = {
	render: () => ({
		components,
		setup: () => ({ value: ref('nfm'), modes: ['nfm', 'am', 'usb', 'lsb', 'wfm', 'dsb', 'cw', 'raw', 'dsd'] }),
		template:
			'<div class="mode-grid" style="max-width:320px"><UiRadio v-for="mode in modes" :key="mode" v-model="value" :value="mode" name="modes">{{ mode.toUpperCase() }}</UiRadio></div>',
	}),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByText('WFM'));
		await expect(canvas.getByLabelText('WFM', { selector: 'input' })).toBeChecked();
	},
};
export const Sliders: Story = {
	render: () => ({
		components,
		setup: () => ({ volume: ref(75), squelch: ref(-65) }),
		template:
			'<div style="width:320px;display:flex;flex-direction:column;gap:12px"><UiFormRow label="Volume"><UiSlider v-model="volume" :min="0" :max="100" input-label="Volume" :value-text="volume + \'%\'"/></UiFormRow><UiFormRow label="Squelch"><UiSlider v-model="squelch" :min="-100" :max="0" :step="0.1" compact input-label="Squelch" :value-text="squelch.toFixed(3) + \'dB\'"/></UiFormRow><UiSlider :model-value="50" disabled input-label="Disabled"/></div>',
	}),
};
export const Spinbox: Story = {
	render: () => ({
		components,
		setup: () => ({ value: ref(12000) }),
		template: '<UiSpinbox v-model="value" :step="1000" input-label="Bandwidth"/>',
	}),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: 'Increase Bandwidth' }));
		await expect(canvas.getByRole('spinbutton')).toHaveValue(13000);
	},
};
export const Disabled: Story = {
	render: () => ({
		components,
		template:
			'<div style="width:320px;display:flex;flex-direction:column;gap:12px"><UiInputGroup unit="MHz"><UiInput :model-value="100" type="number" disabled aria-label="Center"/></UiInputGroup><UiSelect model-value="wfm" disabled aria-label="Mode"><option value="wfm">WFM</option></UiSelect><UiSpinbox :model-value="12000" :step="1000" disabled/><UiCheckbox :model-value="true" disabled label="Stereo"/></div>',
	}),
};
