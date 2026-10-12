import { ref } from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, within } from 'storybook/test';
import { UiButton, UiDialog, UiNotice } from '..';

const usb = {
	title: 'WebUSB is unavailable',
	message:
		'This browser cannot connect to USB SDR devices. Use a browser with WebUSB enabled, such as Chrome or Edge. You can still use a remote receiver or Mock SDR.',
	href: 'https://caniuse.com/webusb',
	linkLabel: 'See browsers that support WebUSB',
};
const meta = { title: 'UI/Notice', component: UiNotice, tags: ['autodocs'] } satisfies Meta<typeof UiNotice>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MissingWebUsb: Story = { args: usb };
export const SecureConnectionRequired: Story = {
	args: {
		...usb,
		title: 'USB connections need a secure connection',
		message:
			'Open BrowSDR over HTTPS (or localhost for local development) to connect a USB SDR. You can still use a remote receiver or Mock SDR.',
	},
};
export const MissingWebRtc: Story = {
	args: {
		title: 'WebRTC is unavailable',
		message:
			'This browser cannot connect to or share a remote receiver. Use a browser with WebRTC enabled. Local USB receivers and Mock SDR remain available.',
		href: 'https://caniuse.com/rtcpeerconnection',
		linkLabel: 'See browsers that support WebRTC',
	},
};
export const MissingCoreFeature: Story = {
	args: {
		title: 'WebAssembly is unavailable',
		message: 'BrowSDR needs WebAssembly to process radio signals. Use a browser with WebAssembly enabled.',
		href: 'https://caniuse.com/wasm',
		linkLabel: 'See browsers that support WebAssembly',
	},
};
export const AddSdrWithoutUsb: Story = {
	render: () => ({
		components: { UiNotice, UiDialog, UiButton },
		setup: () => ({ issue: usb, open: ref(true), demo: ref(false) }),
		template: `<UiButton @click="open = true">Add SDR</UiButton>
			<UiDialog :open="open" title="Add SDR" body-variant="flush" @close="open = false">
				<UiNotice v-bind="issue" />
				<div class="device-picker-list"><UiButton variant="device" @click="demo = true; open = false">
					<span class="device-picker-name">Mock SDR</span><span class="device-picker-meta">Simulated receiver for testing</span>
				</UiButton></div>
				<template #footer><UiButton variant="primary" disabled>Pair New Device</UiButton><UiButton @click="open = false">Cancel</UiButton></template>
			</UiDialog><p v-if="demo" role="status">Mock SDR selected</p>`,
	}),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('button', { name: 'Pair New Device' })).toBeDisabled();
		await expect(canvas.getByRole('link')).toHaveAttribute('href', 'https://caniuse.com/webusb');
		await userEvent.click(canvas.getByRole('button', { name: /Mock SDR/ }));
		await expect(canvas.queryByRole('dialog')).not.toBeInTheDocument();
		await expect(canvas.getByText('Mock SDR selected')).toBeVisible();
	},
};
