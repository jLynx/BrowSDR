import { ref } from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, within } from 'storybook/test';
import { UiPanel, UiFormRow, UiInputGroup, UiInput } from '..';

const meta = {
	title: 'UI/Panel',
	component: UiPanel,
	tags: ['autodocs'],
	args: { label: 'Radio', collapsed: false },
	render: (args) => ({
		components: { UiPanel, UiFormRow, UiInputGroup, UiInput },
		setup: () => ({ args, collapsed: ref(args.collapsed), frequency: ref(100) }),
		template:
			'<div style="width:320px"><UiPanel v-bind="args" v-model:collapsed="collapsed"><UiFormRow label="Center"><UiInputGroup unit="MHz"><UiInput v-model.number="frequency" type="number" aria-label="Center frequency"/></UiInputGroup></UiFormRow></UiPanel></div>',
	}),
} satisfies Meta<typeof UiPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Expanded: Story = {};
export const Collapsed: Story = { args: { collapsed: true } };
export const Disabled: Story = { args: { disabled: true } };
export const OutOfBand: Story = { args: { outOfBand: true, label: 'VFO 1' } };
export const Condensed: Story = { args: { condensed: true } };
export const Static: Story = { args: { collapsible: false } };
export const Advanced: Story = { args: { label: 'Advanced', collapsed: true } };
export const Nested: Story = {
	render: () => ({
		components: { UiPanel, UiFormRow },
		setup: () => ({ sourceCollapsed: ref(false), infoCollapsed: ref(true), hardwareCollapsed: ref(true) }),
		template: `<div style="width:320px"><UiPanel label="Source" v-model:collapsed="sourceCollapsed">
			<UiFormRow label="Device"><small>LimeSDR-USB</small></UiFormRow>
			<UiPanel label="Device info" v-model:collapsed="infoCollapsed">
				<UiFormRow label="Firmware"><small>4</small></UiFormRow>
				<UiFormRow label="Gateware"><small>2.22</small></UiFormRow>
				<UiPanel label="Hardware details" v-model:collapsed="hardwareCollapsed">
					<UiFormRow label="Revision"><small>1.4</small></UiFormRow>
				</UiPanel>
			</UiPanel>
		</UiPanel></div>`,
	}),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const info = canvas.getByRole('button', { name: 'Device info' });
		await expect(info).toHaveAttribute('aria-expanded', 'false');
		await userEvent.click(info);
		await expect(info).toHaveAttribute('aria-expanded', 'true');
		await expect(canvas.getByRole('button', { name: 'Source' })).toHaveAttribute('aria-expanded', 'true');
		const hardware = canvas.getByRole('button', { name: 'Hardware details' });
		hardware.focus();
		await userEvent.keyboard('{Enter}');
		await expect(hardware).toHaveAttribute('aria-expanded', 'true');
	},
};
export const KeyboardToggle: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const header = canvas.getByRole('button', { name: 'Radio' });
		header.focus();
		await userEvent.keyboard('{Enter}');
		await expect(header).toHaveAttribute('aria-expanded', 'false');
		await expect(canvas.getByRole('spinbutton', { hidden: true })).not.toBeVisible();
		await userEvent.keyboard(' ');
		await expect(header).toHaveAttribute('aria-expanded', 'true');
	},
};
