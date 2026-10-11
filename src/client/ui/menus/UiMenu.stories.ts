import { ref } from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, within } from 'storybook/test';
import { UiMenu } from '@/ui';

const meta = {
	title: 'UI/Menu',
	component: UiMenu,
	tags: ['autodocs'],
	args: {
		id: 'storybook-tools',
		label: 'Tools',
		groups: [
			{
				label: 'Decoders',
				items: [
					{ id: 'rds', label: 'FM RDS', description: 'FM station information', icon: 'radio', active: true, open: false },
					{ id: 'sensors', label: 'Wireless Sensors', description: 'Sensor & device data · rtl_433', icon: 'sensors' },
					{ id: 'adsb', label: 'ADS-B', description: 'Aircraft tracking', icon: 'aircraft' },
					{ id: 'acars', label: 'ACARS', description: 'Aircraft messages', icon: 'message' },
				],
			},
			{ label: 'Utilities', items: [{ id: 'stats', label: 'DSP Stats', description: 'Receiver performance', icon: 'stats' }] },
		],
	},
	render: (args) => ({
		components: { UiMenu },
		setup() {
			return { args, selected: ref('') };
		},
		template:
			'<div style="min-height:380px;display:flex;justify-content:flex-end;padding:8px"><UiMenu v-bind="args" @select="selected = $event"/><span role="status">{{ selected }}</span></div>',
	}),
} satisfies Meta<typeof UiMenu>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Grouped: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const trigger = canvas.getByRole('button', { name: 'Tools' });
		await userEvent.click(trigger);
		await expect(trigger).toHaveAttribute('aria-expanded', 'true');
		await expect(canvas.getByText('Sensor & device data · rtl_433')).toBeVisible();
		await expect(canvas.getByRole('button', { name: 'Wireless Sensors' })).toHaveAccessibleDescription('Sensor & device data · rtl_433');
		await userEvent.click(canvas.getByRole('button', { name: 'Wireless Sensors' }));
		await expect(canvas.getByRole('status')).toHaveTextContent('sensors');
		await expect(trigger).toHaveFocus();
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');
		await userEvent.click(trigger);
		await userEvent.keyboard('{Escape}');
		await expect(trigger).toHaveFocus();
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	},
};

export const SplitAction: Story = {
	args: {
		id: 'storybook-gains',
		label: 'Auto gain preferences',
		primaryLabel: 'Auto set gains',
		groups: [
			{
				label: 'Auto set gains',
				items: [
					{ id: 'balanced', label: 'Balanced', description: 'Everyday reception with room for peaks', icon: 'radio' },
					{ id: 'sensitivity', label: 'Weak signals', description: 'Favor early amplification for distant signals', icon: 'radio' },
					{ id: 'strong', label: 'Strong signals', description: 'Reduce early gain and leave extra headroom', icon: 'radio' },
				],
			},
		],
	},
	render: (args) => ({
		components: { UiMenu },
		setup: () => ({ args, selected: ref('') }),
		template:
			'<div style="min-height:300px;padding:8px"><UiMenu v-bind="args" @primary="selected = &quot;balanced&quot;" @select="selected = $event"/><span role="status">{{ selected }}</span></div>',
	}),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: 'Auto set gains' }));
		await expect(canvas.getByRole('status')).toHaveTextContent('balanced');
		const trigger = canvas.getByRole('button', { name: 'Auto gain preferences' });
		await userEvent.click(trigger);
		await userEvent.click(canvas.getByRole('button', { name: 'Weak signals' }));
		await expect(canvas.getByRole('status')).toHaveTextContent('sensitivity');
		await expect(trigger).toHaveFocus();
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	},
};
export const SplitDisabled: Story = { ...SplitAction, args: { ...SplitAction.args, disabled: true }, play: undefined };
