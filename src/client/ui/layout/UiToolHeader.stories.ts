import type { Meta, StoryObj } from '@storybook/vue3-vite';
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
export const Sensors: Story = {
	render: () => ({
		components: { UiToolHeader, UiButton },
		template:
			'<div class="rtl433-panel"><UiToolHeader>rtl_433 Sensors <span class="pocsag-count">0 events</span><template #actions><UiButton variant="transcript">Protocols</UiButton><UiButton variant="transcript">Clear</UiButton><UiButton variant="transcript" disabled>Export JSONL</UiButton></template></UiToolHeader></div>',
	}),
};
