import { ref } from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, within } from 'storybook/test';
import { UiDialog, UiButton, UiInput } from '..';
import { dialogVariants } from './UiDialog';

const meta = {
	title: 'UI/Dialog',
	component: UiDialog,
	tags: ['autodocs'],
	args: { open: true, title: 'Save Bookmark', variant: 'default', dismissible: true },
	argTypes: {
		variant: { control: 'select', options: Object.keys(dialogVariants) },
		bodyVariant: { control: 'select', options: ['padded', 'flush'] },
	},
	render: (args) => ({
		components: { UiDialog, UiButton, UiInput },
		setup: () => ({ args, open: ref(args.open), name: ref('FM station') }),
		template:
			'<UiButton @click="open = true">Open dialog</UiButton><UiDialog v-bind="args" :open="open" @close="open = false"><UiInput v-model="name" class="bookmark-dialog-input" aria-label="Bookmark name"/><p class="bookmark-dialog-info">Freq: <b>100 MHz</b> · Mode: <b>WFM</b></p><template #footer><UiButton @click="open = false">Cancel</UiButton><UiButton variant="primary" @click="open = false">Save</UiButton></template></UiDialog>',
	}),
} satisfies Meta<typeof UiDialog>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Edit: Story = { args: { variant: 'edit', title: 'Edit Bookmark' } };
export const Import: Story = { args: { variant: 'import', title: 'Import Bookmarks' } };
export const Clients: Story = { args: { variant: 'clients', title: 'Connected Clients' } };
export const About: Story = { args: { variant: 'about', title: 'About BrowSDR' } };
export const DevicePicker: Story = {
	args: { title: 'Add SDR', bodyVariant: 'flush' },
	render: (args) => ({
		components: { UiDialog, UiButton },
		setup: () => ({ args, open: ref(true) }),
		template: `<UiDialog v-bind="args" :open="open" @close="open = false" dialog-class="device-picker-dialog">
			<div class="device-picker-list">
				<UiButton variant="device">
					<span class="device-picker-name">SDR 1 · HackRF</span>
					<span class="device-picker-meta">HackRF One</span>
				</UiButton>
				<UiButton variant="device">
					<span class="device-picker-name">Mock SDR</span>
					<span class="device-picker-meta">Simulated receiver for testing</span>
				</UiButton>
			</div>
			<template #footer>
				<UiButton variant="primary">Pair New Device</UiButton>
				<UiButton @click="open = false">Cancel</UiButton>
			</template>
		</UiDialog>`,
	}),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const dialog = canvas.getByRole('dialog');
		const body = dialog.querySelector('.bookmark-dialog-body')!;
		const list = dialog.querySelector('.device-picker-list')!;
		await expect(getComputedStyle(body).padding).toBe('0px');
		await expect(list.getBoundingClientRect().left).toBe(body.getBoundingClientRect().left);
		await expect(list.getBoundingClientRect().right).toBe(body.getBoundingClientRect().right);
		await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
		await expect(canvas.queryByRole('dialog')).toBeNull();
	},
};
export const Conflict: Story = { args: { dismissible: false, title: 'VFO Outside Bandwidth' } };
export const Closed: Story = { args: { open: false } };
export const Dismiss: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('textbox'));
		await expect(canvas.getByRole('dialog')).toBeVisible();
		await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
		await expect(canvas.queryByRole('dialog')).toBeNull();
	},
};
