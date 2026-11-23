import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, within } from 'storybook/test';
import KeyboardShortcuts from '@/app/display/shortcuts';
import { UiButton } from '..';

const meta = {
	title: 'Receiver/Keyboard Shortcuts',
	component: KeyboardShortcuts,
	tags: ['autodocs'],
	render: () => ({
		components: { KeyboardShortcuts, UiButton },
		template: `<div style="width:300px"><div class="sidebar-footer">
			<UiButton variant="icon" class="sidebar-about-btn">About</UiButton>
			<KeyboardShortcuts />
		</div></div>`,
	}),
} satisfies Meta<typeof KeyboardShortcuts>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Footer: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const page = within(canvasElement.ownerDocument.body);
		const trigger = canvas.getByRole('button', { name: 'Keyboard shortcuts' });
		trigger.focus();
		await userEvent.keyboard('{Enter}');
		const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
		await expect(dialog).toHaveTextContent('Tune the selected VFO');
		await expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
		await userEvent.keyboard('{Escape}');
		await expect(page.queryByRole('dialog')).not.toBeInTheDocument();
		await expect(trigger).toHaveFocus();
		await userEvent.click(trigger);
		await userEvent.click(page.getByRole('button', { name: 'Close' }));
		await expect(trigger).toHaveFocus();
	},
};
