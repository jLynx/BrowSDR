import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, within } from 'storybook/test';
import { onBeforeUnmount, provide, reactive } from 'vue';
import RtkPanel from '@/app/decoders/rtk/panel';
import { createAppData } from '@/app/core/state';
import { makeDefaultVfo } from '@/app/core/constants';
import type { AppInstance } from '@/app/core/receiver.types';
import type { RtkStation } from '@/worker/decoders/rtk/types';

function mockBase(scan: number, name: string, longitude: number): RtkStation {
	const now = Date.now();
	return {
		name,
		scan,
		channel: 7,
		netId: 42,
		packets: 12,
		rtcmCount: 24,
		rtcmTypes: { 1006: 4, 1074: 20 },
		lastSeen: now,
		lastCorrection: now,
		cfoHz: 0,
		reference: { stationId: 42, itrf: 0, latitude: 0, longitude, heightM: 0, ecef: [1, 2, 3] },
		observations: {
			GPS: {
				type: 1074,
				stationId: 42,
				constellation: 'GPS',
				epochMs: 1000,
				multipleMessage: false,
				satellites: [1, 2],
				signals: [2, 10],
				cells: 4,
				cnrDbHz: [42, 44, 41, 43],
				receivedAt: now,
				measurements: [1, 2].flatMap((satellite) => [
					{ satellite, signal: 2, cnrDbHz: 42, band: 'L1', group: 'primary' as const },
					{ satellite, signal: 10, cnrDbHz: 44, band: 'L2', group: 'secondary' as const },
				]),
			},
		},
	};
}

const meta = {
	title: 'Receiver/RTK Base Stations',
	component: RtkPanel,
	parameters: {
		docs: { description: { component: 'Invented RTK bases and coordinates for layout review. No RF captures or personal station data.' } },
	},
	render: () => ({
		components: { RtkPanel },
		setup() {
			const receiver = reactive({
				...createAppData(),
				running: true,
				isFreqInBandwidth: () => true,
				updateBackendVfoParams: () => {},
				tuneRtkVfo: () => {},
			});
			receiver.vfos = [923.118, 921.25].map((frequency) => ({ ...makeDefaultVfo(frequency), rtk: true, enabled: false }));
			receiver.rtk.panelOpen = true;
			receiver.rtk.frequencies = [923.118, 921.25];
			receiver.rtk.sources = [[mockBase(1234, 'MOCK GNSS A', 0), mockBase(2345, 'MOCK GNSS B', 90)], [mockBase(3456, 'MOCK GNSS C', 0)]];
			receiver.rtk.status = [0, 1].map(() => ({
				state: 'receiving',
				message: 'Synthetic display fixture',
				samples: 1000,
				headers: 12,
				packets: 12,
				syncs: 12,
				crcErrors: 0,
				discontinuities: 0,
			}));
			const timer = setInterval(() => {
				for (const station of receiver.rtk.sources.flat()) {
					station.lastCorrection = station.lastSeen = Date.now();
					for (const observation of Object.values(station.observations ?? {})) observation.receivedAt = Date.now();
				}
			}, 1000);
			onBeforeUnmount(() => clearInterval(timer));
			provide('receiver', receiver as unknown as AppInstance);
		},
		template:
			'<div style="display:flex;flex-direction:column;min-height:640px"><p style="padding:12px">Mock RTK stations · No live radio or personal coordinates</p><RtkPanel /></div>',
	}),
} satisfies Meta<typeof RtkPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MultipleBases: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const details = canvas.getByRole('region', { name: 'Selected RTK base station' }).getBoundingClientRect();
		const directory = canvas.getByRole('region', { name: 'Discovered RTK base stations' }).getBoundingClientRect();
		const panel = canvas.getByLabelText('Live RTK decoder').getBoundingClientRect();
		if (panel.width > 760) {
			await expect(directory.left).toBeGreaterThanOrEqual(details.right);
			await expect(directory.top).toBe(details.top);
		} else {
			await expect(directory.top).toBeGreaterThanOrEqual(details.bottom);
			const detailsElement = canvas.getByRole('region', { name: 'Selected RTK base station' });
			await expect(detailsElement.scrollHeight).toBeLessThanOrEqual(detailsElement.clientHeight + 1);
		}
		const list = within(canvas.getByRole('table', { name: 'RTK base stations' }));
		await expect(list.getAllByRole('row')).toHaveLength(4);
		await userEvent.click(list.getByRole('button', { name: /MOCK GNSS B/ }));
		await expect(canvas.getByLabelText('LoRa number')).toHaveTextContent('2345.7.?.42');
		await userEvent.click(list.getByRole('button', { name: /MOCK GNSS C/ }));
		await expect(canvas.getByLabelText('LoRa number')).toHaveTextContent('3456.7.?.42');
	},
};

export const NarrowLayout: Story = {
	render: () => ({
		...meta.render(),
		template: '<div style="display:flex;flex-direction:column;width:390px;max-width:100%"><RtkPanel /></div>',
	}),
	play: MultipleBases.play,
};
