import { ref } from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, within } from 'storybook/test';
import { UiBandwidth, UiButton } from '..';

const meta = {
	title: 'UI/Bandwidth',
	component: UiBandwidth,
	tags: ['autodocs'],
	decorators: [() => ({ template: '<div style="width: 280px"><story /></div>' })],
} satisfies Meta<typeof UiBandwidth>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Host: Story = {
	render: () => ({
		components: { UiBandwidth, UiButton },
		setup: () => ({ clients: ref(2) }),
		template: `<UiBandwidth host ready :peers="clients" :upload-bps="clients * 600000" :download-bps="4000" />
			<UiButton @click="clients++">Add client</UiButton>`,
	}),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText('9.60 Mbps')).toBeVisible();
		await userEvent.click(canvas.getByRole('button', { name: 'Add client' }));
		await expect(canvas.getByText('14.40 Mbps')).toBeVisible();
		await expect(canvas.getByText('3 clients · total across all SDRs')).toBeVisible();
	},
};
export const Client: Story = {
	args: { ready: true, downloadBps: 625000, uploadBps: 4000, peers: 1 },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText('Live download')).toBeVisible();
		await expect(canvas.getByText('5.00 Mbps')).toBeVisible();
	},
};
export const Measuring: Story = { args: { peers: 1 } };
export const WaitingForClients: Story = { args: { host: true, ready: true } };
export const Unavailable: Story = { args: { unavailable: true, peers: 1 } };
