import type { Meta, StoryObj } from '@storybook/vue3-vite';
import UiEmptyState from './UiEmptyState';

const meta = {
	title: 'UI/Empty State', component: UiEmptyState, tags: ['autodocs'], args: { variant: 'bookmark' },
	render: args => ({ components: { UiEmptyState }, setup: () => ({ args }), template: '<UiEmptyState v-bind="args">No entries yet.</UiEmptyState>' }),
} satisfies Meta<typeof UiEmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Bookmark: Story = {};
export const Transcript: Story = { args: { variant: 'transcript' } };
export const Pager: Story = { args: { variant: 'pocsag' } };
export const Activity: Story = { args: { variant: 'activity' } };
export const Clients: Story = { args: { variant: 'remote-clients' } };
