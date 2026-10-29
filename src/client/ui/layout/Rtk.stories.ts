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
			receiver.rtk.sources = [
				[mockBase(1234, 'MOCK GNSS A', 0), mockBase(2345, 'MOCK GNSS B', 90)],
				[mockBase(3456, 'MOCK GNSS C', 0), mockBase(4567, 'MOCK GNSS D', 45), mockBase(5678, 'MOCK GNSS E', -45)],
			];
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
		const panelElement = canvas.getByLabelText('Live RTK decoder');
		const body = panelElement.querySelector<HTMLElement>('.rtk-body')!;
		const detailsElement = canvas.getByRole('region', { name: 'Selected RTK base station' });
		const directoryElement = canvas.getByRole('region', { name: 'Discovered RTK base stations' });
		body.scrollTop = 0;
		const details = detailsElement.getBoundingClientRect();
		const directory = directoryElement.getBoundingClientRect();
		const panel = panelElement.getBoundingClientRect();
		const map = canvas.getByRole('region', { name: 'Base station location map' }).getBoundingClientRect();
		await expect(body.firstElementChild).toBe(directoryElement);
		await expect(directory.bottom).toBeLessThanOrEqual(details.top + 1);
		await expect(directory.top).toBeGreaterThanOrEqual(body.getBoundingClientRect().top);
		await expect(getComputedStyle(body).overflowY).toBe('auto');
		await expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
		// The whole panel scrolls through the directory and details together.
		for (const element of panelElement.querySelectorAll<HTMLElement>('.rtk-directory, .rtk-station-scroll, .rtk-details')) {
			await expect(getComputedStyle(element).overflowY).toBe('visible');
			await expect(element.scrollHeight).toBeLessThanOrEqual(element.clientHeight + 1);
		}
		await expect(map.width).toBeGreaterThan(240);
		await expect(panelElement.scrollWidth).toBeLessThanOrEqual(panelElement.clientWidth);
		if (panel.width > 760) {
			await expect(map.top).toBeLessThanOrEqual(details.top + 16);
			await expect(map.bottom).toBeLessThanOrEqual(details.bottom);
		} else {
			const metrics = canvas.getByLabelText('Base station position').getBoundingClientRect();
			await expect(map.bottom).toBeLessThanOrEqual(metrics.top);
		}
		body.scrollTop = details.top - body.getBoundingClientRect().top;
		await expect(body.scrollTop).toBeGreaterThan(0);
		await expect(directoryElement.getBoundingClientRect().top).toBeCloseTo(directory.top - body.scrollTop, 0);
		await expect(detailsElement.getBoundingClientRect().top).toBeLessThan(body.getBoundingClientRect().bottom);
		body.scrollTop = 0;
		const table = canvas.getByRole('table', { name: 'RTK base stations' });
		const list = within(table);
		await expect(table.querySelectorAll('tbody tr')).toHaveLength(5);
		const selectB = list.getByRole('button', { name: /LoRa 2345\.7\.\?\.42/ });
		selectB.scrollIntoView({ block: 'nearest' });
		await userEvent.click(selectB);
		await expect(canvas.getByLabelText('LoRa number')).toHaveTextContent('2345.7.?.42');
		await userEvent.click(list.getByRole('button', { name: /LoRa 3456\.7\.\?\.42/ }));
		await expect(canvas.getByLabelText('LoRa number')).toHaveTextContent('3456.7.?.42');
		await userEvent.click(list.getByRole('button', { name: /LoRa 5678\.7\.\?\.42/ }));
		await expect(canvas.getByLabelText('LoRa number')).toHaveTextContent('5678.7.?.42');
	},
};

export const NarrowLayout: Story = {
	render: () => ({
		...meta.render(),
		template: '<div style="display:flex;flex-direction:column;width:390px;max-width:100%"><RtkPanel /></div>',
	}),
	play: MultipleBases.play,
};

export const ShortPanel: Story = {
	render: () => ({
		...meta.render(),
		template: '<div style="width:1000px;max-width:100%"><RtkPanel style="height:420px" /></div>',
	}),
	play: MultipleBases.play,
};

export const SmallPhone: Story = {
	render: () => ({
		...meta.render(),
		template: '<div style="width:320px;max-width:100%"><RtkPanel /></div>',
	}),
	play: MultipleBases.play,
};
