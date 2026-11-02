import { ref } from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, within } from 'storybook/test';
import HdRadioPanel from '@/app/decoders/hd-radio/panel';
import { makeDefaultVfo } from '@/app/core/constants';
import { emptyHdStatus, type HdStatus } from '@/worker/decoders/hd-radio/types';

const locked: HdStatus = {
	...emptyHdStatus(),
	state: 'locked',
	message: 'Digital signal locked',
	station: 'KSMG',
	slogan: 'HD-1',
	stationMessage: 'magic1053.com',
	frames: 104,
	ber: 0,
	merLower: 13,
	merUpper: 13.6,
	programs: [{ program: 0, title: 'Manchild', artist: 'Sabrina Carpenter', album: '', genre: '', restricted: false }],
};
const meta = {
	title: 'Receiver/HD Radio',
	component: HdRadioPanel,
	tags: ['autodocs'],
	args: { vfo: { ...makeDefaultVfo(105.3), mode: 'hdradio' }, status: locked },
	render: (args) => ({
		components: { HdRadioPanel },
		setup: () => ({ args, vfo: ref({ ...args.vfo }) }),
		template: '<div style="width:300px"><HdRadioPanel :vfo="vfo" :status="args.status" @program="vfo.hdProgram = $event" /></div>',
	}),
} satisfies Meta<typeof HdRadioPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Locked: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText('KSMG')).toBeVisible();
		await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'HD Radio program' }), '1');
		await expect(canvas.getByText('HD2 has not been advertised by this station.')).toBeVisible();
		await expect(canvas.queryByText('Manchild')).not.toBeInTheDocument();
	},
};
export const Loading: Story = { args: { status: { ...emptyHdStatus(), state: 'loading', message: 'Loading HD Radio…' } } };
export const Searching: Story = { args: { status: { ...emptyHdStatus(), state: 'searching', message: 'Searching for HD Radio' } } };
export const OutOfBand: Story = {
	args: { status: { ...emptyHdStatus(), state: 'error', message: 'HD Radio needs the full 400 kHz station inside the received band.' } },
};
export const Restricted: Story = { args: { status: { ...locked, programs: [{ ...locked.programs[0], restricted: true }] } } };
