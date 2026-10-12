import { ref } from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import UiFrequencyDisplay from './UiFrequencyDisplay';

const meta = {
	title: 'UI/Frequency Display',
	component: UiFrequencyDisplay,
	tags: ['autodocs'],
	args: { modelValue: '100.000000', index: 0, color: '#3a86ff', enabled: true, onApply: fn() },
	render: (args) => ({
		components: { UiFrequencyDisplay },
		setup: () => ({ args, frequency: ref(args.modelValue) }),
		template: '<div class="vfo-displays"><UiFrequencyDisplay v-bind="args" v-model="frequency"/></div>',
	}),
} satisfies Meta<typeof UiFrequencyDisplay>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Active: Story = { args: { active: true } };
export const Receiving: Story = { args: { receiving: true } };
export const Muted: Story = { args: { enabled: false } };
export const OutOfBand: Story = { args: { outOfBand: true } };
export const Bookmark: Story = { args: { bookmark: 'FM station', active: true } };
export const ApplyFrequency: Story = {
	play: async ({ canvasElement, args }) => {
		const input = within(canvasElement).getByRole('textbox');
		await userEvent.clear(input);
		await userEvent.type(input, '106.5{Enter}');
		await expect(input).toHaveValue('106.5');
		await expect(args.onApply).toHaveBeenCalledOnce();
	},
};
