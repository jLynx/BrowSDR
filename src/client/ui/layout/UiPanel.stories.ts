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
