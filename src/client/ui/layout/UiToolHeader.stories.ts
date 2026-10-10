import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, within } from 'storybook/test';
import { UiToolHeader, UiButton, UiBadge, UiEmptyState } from '..';

const meta = {
	title: 'UI/Tool Header',
	component: UiToolHeader,
	tags: ['autodocs'],
	args: { variant: 'pocsag' },
	render: (args) => ({
		components: { UiToolHeader, UiButton, UiBadge, UiEmptyState },
		setup: () => ({ args }),
		template:
			'<UiToolHeader v-bind="args">Decoder <UiBadge>Ready</UiBadge><template #actions><UiButton variant="transcript">Clear</UiButton><UiButton variant="transcript" disabled>Export</UiButton></template></UiToolHeader><UiEmptyState :variant="args.variant">Waiting for a transmission…</UiEmptyState>',
	}),
} satisfies Meta<typeof UiToolHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Pager: Story = {};
export const Transcript: Story = { args: { variant: 'transcript' } };
export const Activity: Story = { args: { variant: 'activity' } };
export const Closable: Story = {
	args: { closable: true, closeLabel: 'Close decoder' },
	render: (args) => ({
		components: { UiToolHeader, UiButton },
		setup: () => ({ args }),
		data: () => ({ open: true }),
		template:
			'<div style="max-width:360px"><UiToolHeader v-if="open" v-bind="args" @close="open = false">Decoder<template #actions><UiButton variant="transcript">Clear</UiButton><UiButton variant="transcript">Export messages</UiButton><UiButton variant="transcript">Settings</UiButton></template></UiToolHeader></div>',
	}),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: 'Close decoder' }));
		await expect(canvas.queryByRole('button', { name: 'Close decoder' })).not.toBeInTheDocument();
	},
};
export const Sensors: Story = {
	render: () => ({
		components: { UiToolHeader, UiButton },
		template:
			'<div class="rtl433-panel"><UiToolHeader>Wireless Sensors <span class="pocsag-count">0 events</span><template #actions><UiButton variant="transcript">Protocols</UiButton><UiButton variant="transcript">Clear</UiButton><UiButton variant="transcript" disabled>Export JSONL</UiButton></template></UiToolHeader></div>',
	}),
};
