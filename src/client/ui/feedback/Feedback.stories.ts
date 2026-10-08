import { ref } from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, within } from 'storybook/test';
import { UiBadge, UiLock, UiSnackbar, UiChevron } from '..';
import { badgeVariants } from './UiBadge';

const meta = { title: 'UI/Feedback', component: UiBadge, tags: ['autodocs'] } satisfies Meta<typeof UiBadge>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Badges: Story = {
	render: () => ({
		components: { UiBadge },
		setup: () => ({ variants: Object.keys(badgeVariants) }),
		template:
			'<div style="display:flex;gap:12px;flex-wrap:wrap"><UiBadge v-for="variant in variants" :key="variant" :variant="variant">{{ variant }}</UiBadge></div>',
	}),
};
export const Locks: Story = {
	render: () => ({
		components: { UiLock },
		setup: () => ({ locked: ref(false) }),
		template:
			'<div style="display:flex;gap:12px"><UiLock :locked="locked" host @toggle="locked = !locked" aria-label="Host lock"/><UiLock locked aria-label="Client lock"/></div>',
	}),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const host = canvas.getByRole('button', { name: 'Host lock' });
		await userEvent.click(host);
		await expect(host).toHaveAttribute('aria-pressed', 'true');
		const client = canvas.getByRole('button', { name: 'Client lock' });
		await userEvent.click(client);
		await expect(client).toHaveAttribute('aria-pressed', 'true');
	},
};
export const Snackbar: Story = { render: () => ({ components: { UiSnackbar }, template: '<UiSnackbar show message="Bookmark saved"/>' }) };
export const HiddenSnackbar: Story = {
	render: () => ({ components: { UiSnackbar }, template: '<UiSnackbar :show="false" message="Bookmark saved"/>' }),
};
export const Chevrons: Story = {
	render: () => ({
		components: { UiChevron },
		template: '<div style="display:flex;gap:12px"><UiChevron/><UiChevron collapsed/><UiChevron :size="12"/></div>',
	}),
};
