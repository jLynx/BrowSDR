import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, within } from 'storybook/test';
import { provide, reactive } from 'vue';
import IqCapturePanel from '@/app/recording/panel';
import { createAppData } from '@/app/core/state';
import type { AppInstance } from '@/app/core/receiver.types';

function renderRecorder(running = true, pending = false) {
	return {
		components: { IqCapturePanel },
		setup() {
			let rejectCapture: ((error: Error) => void) | undefined;
			const data = createAppData();
			const receiver = reactive({
				...data,
				running,
				iqRecording: { panelOpen: true, active: false },
				radio: { ...data.radio, centerFreq: 100, sampleRate: 2e6 },
				backend: {
					captureIq(seconds: number) {
						if (pending)
							return new Promise<{ data: Int8Array; missingSamples: number }>((_, reject) => {
								rejectCapture = reject;
							});
						return Promise.resolve({ data: new Int8Array(Math.round(seconds * 2e6 * 2)), missingSamples: 0 });
					},
					getIqCaptureProgress: () => Promise.resolve({ capturedBytes: 8e6, writtenBytes: 8e6, totalBytes: 20e6 }),
					cancelIqCapture() {
						rejectCapture?.(new Error('Recording cancelled.'));
						return Promise.resolve();
					},
				},
			});
			provide('receiver', receiver as unknown as AppInstance);
		},
		template: '<IqCapturePanel />',
	};
}

const meta = {
	title: 'Receiver/IQ Recorder',
	component: IqCapturePanel,
	parameters: {
		docs: {
			description: { component: 'Full-band IQ recording for signal analysis. These previews use simulated samples; no SDR is connected.' },
		},
	},
	render: () => renderRecorder(),
} satisfies Meta<typeof IqCapturePanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const Disconnected: Story = {
	render: () => renderRecorder(false),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('button', { name: 'Start recording' })).toBeDisabled();
		await expect(canvas.getByRole('status')).toHaveTextContent('Start reception');
	},
};
export const Recording: Story = {
	render: () => renderRecorder(true, true),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: 'Start recording' }));
		await expect(canvas.getByRole('button', { name: 'Cancel recording' })).toBeVisible();
		await expect(canvas.getByLabelText('Recording duration')).toBeDisabled();
		await expect(canvas.getByRole('progressbar')).toBeVisible();
	},
};
export const Completed: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: 'Start recording' }));
		await expect(await canvas.findByRole('button', { name: 'Download IQ data' })).toBeVisible();
		await expect(canvas.getByRole('button', { name: 'Download metadata' })).toBeVisible();
		await expect(canvas.getByRole('status')).toHaveTextContent('Your recording is ready');
		await userEvent.click(canvas.getByText('About IQ recordings'));
		await expect(canvas.getByText(/compatible signal analysis software/)).toBeVisible();
	},
};
export const CancelRecording: Story = {
	render: () => renderRecorder(true, true),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: 'Start recording' }));
		await userEvent.click(canvas.getByRole('button', { name: 'Cancel recording' }));
		await expect(await canvas.findByRole('button', { name: 'Start recording' })).toBeEnabled();
		await expect(canvas.getByRole('status')).toHaveTextContent('Recording cancelled.');
	},
};
