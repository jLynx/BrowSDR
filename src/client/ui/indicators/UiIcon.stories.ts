import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { UiIcon } from '@/ui';

const meta = { title: 'UI/Tool Icons', component: UiIcon, tags: ['autodocs'], args: { name: 'radio' } } satisfies Meta<typeof UiIcon>;
export default meta;
type Story = StoryObj<typeof meta>;
export const All: Story = {
	render: () => ({
		components: { UiIcon },
		setup: () => ({
			names: ['microphone', 'pager', 'radio', 'sensors', 'aircraft', 'bluetooth', 'vessel', 'message', 'stats', 'activity', 'reset'],
		}),
		template:
			'<div style="display:flex;flex-wrap:wrap;gap:20px"><div v-for="name in names" :key="name" style="display:flex;align-items:center;gap:8px"><UiIcon :name="name"/>{{ name }}</div></div>',
	}),
};
