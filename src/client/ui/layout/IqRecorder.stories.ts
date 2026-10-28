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
			let resolveCapture: ((value: { data: Int8Array; missingSamples: number }) => void) | undefined;
			function captureIq(seconds: number | null) {
				if (pending || seconds === null)
					return new Promise<{ data: Int8Array; missingSamples: number }>((resolve, reject) => {
						resolveCapture = resolve;
						rejectCapture = reject;
					});
				return Promise.resolve({ data: new Int8Array(Math.round(seconds * 2e6 * 2)), missingSamples: 0 });
			}
			const data = createAppData();
			const receiver = reactive({
				...data,
				running,
				iqRecording: { panelOpen: true, active: false },
				radio: { ...data.radio, centerFreq: 100, sampleRate: 2e6 },
				backend: {
					captureIq,
					stopIqCapture() {
						resolveCapture?.({ data: new Int8Array([1, -1, 2, -2]), missingSamples: 0 });
						return Promise.resolve();
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
		await expect(canvas.getByRole('button', { name: 'Stop recording' })).toBeEnabled();
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

export const StopRecording: Story = {
	render: () => renderRecorder(true, true),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: 'Start recording' }));
		await userEvent.click(canvas.getByRole('button', { name: 'Stop recording' }));
		await expect(await canvas.findByRole('button', { name: 'Download IQ data' })).toBeVisible();
		await expect(canvas.getByRole('button', { name: 'Download metadata' })).toBeVisible();
	},
};

export const Manual: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.selectOptions(canvas.getByLabelText('Recording mode'), 'manual');
		await expect(canvas.queryByLabelText('Recording duration')).toBeNull();
		await expect(canvas.getByRole('status')).toHaveTextContent('Ready to record.');
	},
};

export const ManualRecording: Story = {
	beforeEach: () => {
		const descriptor = Object.getOwnPropertyDescriptor(window, 'showSaveFilePicker');
		Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
		return () => {
			if (descriptor) Object.defineProperty(window, 'showSaveFilePicker', descriptor);
			else Reflect.deleteProperty(window, 'showSaveFilePicker');
		};
	},
	render: () => renderRecorder(true, true),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.selectOptions(canvas.getByLabelText('Recording mode'), 'manual');
		await userEvent.click(canvas.getByRole('button', { name: 'Start recording' }));
		await expect(canvas.getByRole('button', { name: 'Stop recording' })).toBeEnabled();
		await expect(canvas.getByLabelText('Recording mode')).toBeDisabled();
		await expect(canvas.getByRole('progressbar')).not.toHaveAttribute('value');
		await expect(canvas.getByText(/64 MiB download limit/)).toBeVisible();
	},
};
