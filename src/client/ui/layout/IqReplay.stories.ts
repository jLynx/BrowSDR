import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, within } from 'storybook/test';
import { provide, reactive, markRaw } from 'vue';
import IqReplayPanel from '@/app/replay/panel';
import IqReplayLoader from '@/app/replay/loader';
import { createAppData } from '@/app/core/state';
import type { AppInstance } from '@/app/core/receiver.types';
import type { IqReplayProgress } from '@/radio/iq-replay/types';

function renderReplay(state: IqReplayProgress['state'] = 'ready', mobile = false) {
	return {
		components: { IqReplayPanel, IqReplayLoader },
		setup() {
			const progress = reactive<IqReplayProgress>({ state, seconds: state === 'ready' ? 0 : 25, duration: 60, delaySeconds: 0 });
			const receiver = reactive({
				...createAppData(),
				connected: true,
				running: state === 'playing',
				iqReplay: {
					recording: markRaw({
						file: new File([], 'example-923.118MHz.sigmf-data'),
						sampleRate: 20000000,
						centerHz: 923118000,
						frequencyShiftHz: 0,
						missingSamples: null,
					}),
					progress,
				},
				backend: { getIqReplayProgress: () => Promise.resolve({ ...progress }) },
				togglePlay: () => {
					receiver.running = !receiver.running;
					progress.state = receiver.running ? 'playing' : 'paused';
					return Promise.resolve();
				},
				restartIqReplay: () => {
					receiver.running = true;
					progress.state = 'playing';
					progress.seconds = 0;
					return Promise.resolve();
				},
				showMsg: () => {},
			});
			provide('receiver', receiver as unknown as AppInstance);
		},
		template: `<div style="max-width:${mobile ? '280px' : '360px'};padding:12px"><IqReplayPanel /><IqReplayLoader /></div>`,
	};
}

const meta = {
	title: 'Receiver/IQ File Replay',
	component: IqReplayPanel,
	render: () => renderReplay(),
	parameters: {
		docs: { description: { component: 'Local recorded-IQ playback. These previews use invented filenames and simulated playback state.' } },
	},
} satisfies Meta<typeof IqReplayPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const Playing: Story = {
	render: () => renderReplay('playing'),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: 'Pause replay' }));
		await expect(canvas.getByRole('button', { name: 'Play replay' })).toBeVisible();
		await userEvent.click(canvas.getByRole('button', { name: 'Restart' }));
		await expect(canvas.getByRole('status')).toHaveTextContent('0.0 / 60.0');
	},
};
export const Mobile: Story = { render: () => renderReplay('paused', true) };
export const ChangeRecording: Story = {
	render: () => renderReplay('paused'),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: 'Change recording' }));
		const dialog = canvas.getByRole('dialog', { name: 'Change IQ recording' });
		await expect(dialog).toHaveTextContent('VFO & decoder settings kept');
		await expect(within(dialog).getByRole('button', { name: 'Replace recording' })).toBeDisabled();
		await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
		await expect(dialog).not.toBeInTheDocument();
		await expect(canvas.getByRole('status')).toHaveTextContent('25.0 / 60.0');
	},
};
export const Loader: Story = {
	render: () => ({
		components: { IqReplayLoader },
		setup() {
			provide('receiver', reactive({ ...createAppData(), showIqReplayLoader: true }) as unknown as AppInstance);
		},
		template: '<IqReplayLoader />',
	}),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByLabelText('IQ recording files')).toBeVisible();
		await userEvent.click(canvas.getByText('Supported files & playback', { exact: true }));
		await expect(canvas.getByText(/signed 8-bit I\/Q/)).toBeVisible();
	},
};
