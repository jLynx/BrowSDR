import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, within } from 'storybook/test';
import { nextTick, onBeforeUnmount, provide, reactive } from 'vue';
import RtkPanel from '@/app/decoders/rtk/panel';
import { createAppData } from '@/app/core/state';
import { makeDefaultVfo } from '@/app/core/constants';
import type { AppInstance } from '@/app/core/receiver.types';
import type { RtkStation, RtkHopDecision } from '@/worker/decoders/rtk/types';

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

function mockSurvey(receiver: Pick<AppInstance, 'vfos' | 'radio' | 'rtk'>) {
	receiver.vfos = [{ ...makeDefaultVfo(923.118), rtk: true, rtkProfile: 'scan', enabled: false }];
	Object.assign(receiver.radio, { centerFreq: 923.118, sampleRate: 20000000 });
	receiver.rtk.frequencies = [923.118];
	receiver.rtk.status = [receiver.rtk.status[0]!];
	receiver.rtk.sources = [
		[
			{
				...mockBase(1, 'MOCK GNSS A', 0),
				address: 4242,
				addressPrefix: 100,
				discovery: {
					profile: 'rtk3',
					frequencyMHz: 915.401,
					frequenciesMHz: [915.401, 921.401],
					hoppingObserved: true,
					verifiedFrames: 12,
				},
			},
			{
				...mockBase(2, 'RTK base station', 0),
				address: 4242,
				addressPrefix: 101,
				rtcmCount: 0,
				reference: undefined,
				observations: undefined,
				lastCorrection: undefined,
				discovery: { profile: 'rtk3', frequencyMHz: 915.401, frequenciesMHz: [915.401, 921.401], hoppingObserved: true, verifiedFrames: 3 },
			},
			{
				...mockBase(3, 'MOCK GNSS C', 45),
				protocol: 'rtk2',
				network: '0102030405060708',
				address: 4243,
				discovery: { profile: 'rtk2', frequencyMHz: 921.791, frequenciesMHz: [921.791], hoppingObserved: false, verifiedFrames: 8 },
			},
		],
	];
	receiver.rtk.status[0]!.scan = {
		startMHz: 915,
		endMHz: 928,
		frequencyMHz: 921.401,
		channel: 3,
		channels: 265,
		pass: 1,
		remainingSeconds: 360,
	};
	receiver.rtk.status[0]!.message = 'Discovering RTK bases · 3 verified identities';
	for (const [stationIndex, source] of [
		[0, 'rtk3-100-4242'],
		[2, 'rtk2-0102030405060708-4243'],
	] as const) {
		const base = receiver.rtk.sources[0][stationIndex];
		const frequency = base.discovery!.frequencyMHz;
		receiver.vfos.push({ ...makeDefaultVfo(frequency), rtk: true, rtkProfile: 'auto', rtkFollowSource: source });
		receiver.rtk.frequencies.push(frequency);
		receiver.rtk.sources.push([{ ...base, discovery: undefined, rtcmCount: 40 }]);
		receiver.rtk.status.push({
			...receiver.rtk.status[0]!,
			scan: undefined,
			detectedProfile: base.discovery!.profile,
			hopDecision: 'following',
			hopTracking: true,
		});
	}
}

function mockPanel(followHops = false, automatic?: RtkHopDecision | 'detecting', survey = false) {
	return {
		components: { RtkPanel },
		setup() {
			const receiver = reactive({
				...createAppData(),
				running: true,
				isFreqInBandwidth: () => true,
				updateBackendVfoParams: () => {},
				updateAllBackendVfoParams: () => {},
				applyZoomToEngine: () => {},
				saveSetting: () => {},
				$nextTick: nextTick,
				tuneRtkVfo: () => {},
			});
			receiver.vfos = [923.118, 921.25].map((frequency) => ({ ...makeDefaultVfo(frequency), rtk: true, enabled: false }));
			receiver.rtk.panelOpen = true;
			receiver.rtk.frequencies = [923.118, 921.25];
			receiver.rtk.sources = [
				[mockBase(1234, 'MOCK GNSS A', 0), mockBase(2345, 'MOCK GNSS B', 90)],
				[mockBase(3456, 'MOCK GNSS C', 0), mockBase(4567, 'MOCK GNSS D', 45), mockBase(5678, 'MOCK GNSS E', -45)],
			];
			if (followHops) {
				Object.assign(receiver.vfos[0], { rtkProfile: 'rtk3', rtkFollowHops: true, rtkFollowSource: 'rtk3-100-4242' });
				receiver.rtk.sources[0] = [0, 100, 101].map((addressPrefix, i) => ({
					...mockBase(i, `MOCK GNSS ${i + 1}`, i * 45),
					address: 4242,
					addressPrefix,
				}));
			}
			receiver.rtk.status = [0, 1].map(() => ({
				state: 'receiving',
				message: 'Synthetic display fixture',
				samples: 1000,
				headers: 12,
				packets: 12,
				syncs: 12,
				crcErrors: 0,
				discontinuities: 0,
				...(followHops ? { hopFrequencyMHz: 921.401, hopTracking: true } : {}),
			}));
			if (automatic) {
				Object.assign(receiver.vfos[0], { rtkProfile: 'auto', rtkFollowHops: false });
				if (automatic === 'detecting') {
					receiver.rtk.sources[0] = [];
					receiver.rtk.status[0]!.message = 'Auto: waiting for a verified RTK beacon or two data frames';
				} else
					Object.assign(receiver.rtk.status[0]!, {
						detectedProfile: 'rtk3',
						hopDecision: automatic,
						message:
							automatic === 'following'
								? 'RTK3 detected · Verified NZ hop following'
								: 'RTK3 detected · Receive the whole NZ plan to check hopping',
					});
			}
			if (survey) mockSurvey(receiver);
			const timer = setInterval(() => {
				for (const station of receiver.rtk.sources.flat()) {
					station.lastSeen = Date.now();
					if (station.rtcmCount) station.lastCorrection = Date.now();
					for (const observation of Object.values(station.observations ?? {})) observation.receivedAt = Date.now();
				}
			}, 1000);
			onBeforeUnmount(() => clearInterval(timer));
			provide('receiver', receiver as unknown as AppInstance);
		},
		template:
			'<div style="display:flex;flex-direction:column;min-height:640px"><p style="padding:12px">Mock RTK stations · No live radio or personal coordinates</p><RtkPanel /></div>',
	};
}

const meta = {
	title: 'Receiver/RTK Base Stations',
	component: RtkPanel,
	parameters: {
		docs: { description: { component: 'Invented RTK bases and coordinates for layout review. No RF captures or personal station data.' } },
	},
	render: () => mockPanel(),
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

export const ChooseHopBase: Story = {
	render: () => mockPanel(true),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByText('Decoder settings', { selector: 'summary' }));
		const select = canvas.getByRole('combobox', { name: 'RTK base to follow' });
		await expect(select).toHaveValue('rtk3-100-4242');
		await expect(select.querySelectorAll('option')).toHaveLength(4);
		await userEvent.selectOptions(select, 'rtk3-101-4242');
		await expect(canvas.getByLabelText('LoRa station address')).toHaveTextContent('101:4242');
		await expect(canvas.getByText('Following 921.401 MHz.')).toBeVisible();
		await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
	},
};

export const ChooseHopBaseNarrow: Story = {
	render: () => ({ ...mockPanel(true), template: '<div style="width:320px;max-width:100%"><RtkPanel /></div>' }),
	play: ChooseHopBase.play,
};

export const AutoFollowing: Story = {
	render: () => mockPanel(true, 'following'),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByText('Decoder settings', { selector: 'summary' }));
		await expect(canvas.getByRole('combobox', { name: 'RTK signal profile' })).toHaveValue('auto');
		await expect(canvas.getByLabelText('RTK automatic detection')).toHaveTextContent('RTK3 detected');
		await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'RTK base to follow' }), 'rtk3-101-4242');
		await expect(canvas.getByLabelText('LoRa station address')).toHaveTextContent('101:4242');
		await expect(canvas.queryByRole('spinbutton', { name: 'RTK sample clock correction' })).toBeNull();
		await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
	},
};

export const AutoFollowingNarrow: Story = {
	render: () => ({ ...mockPanel(true, 'following'), template: '<div style="width:320px;max-width:100%"><RtkPanel /></div>' }),
	play: AutoFollowing.play,
};

export const AutoDetecting: Story = {
	render: () => mockPanel(false, 'detecting'),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByText('Decoder settings', { selector: 'summary' }));
		await expect(canvas.getByLabelText('RTK automatic detection')).toHaveTextContent('waiting for a verified RTK beacon');
	},
};

export const AutoLimitedBandwidth: Story = {
	render: () => mockPanel(true, 'band-limited'),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByText('Decoder settings', { selector: 'summary' }));
		await expect(canvas.getByLabelText('RTK automatic detection')).toHaveTextContent('Receive the whole NZ plan');
	},
};

export const RangeDiscovery: Story = {
	render: () => mockPanel(false, undefined, true),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const details = canvas.getByRole('region', { name: 'Selected RTK base station' });
		const heading = details.querySelector<HTMLElement>('.rtk-heading')!.getBoundingClientRect();
		const discovery = details.querySelector<HTMLElement>('.rtk-discovery-detail')!.getBoundingClientRect();
		const map = canvas.getByRole('region', { name: 'Base station location map' }).getBoundingClientRect();
		const freshness = canvas.getByLabelText('Satellite data freshness').getBoundingClientRect();
		await expect(discovery.top - heading.bottom).toBeLessThanOrEqual(16);
		if (details.getBoundingClientRect().width > 760) {
			await expect(freshness.top - discovery.bottom).toBeLessThanOrEqual(20);
			await expect(map.top).toBeCloseTo(heading.top, 0);
		} else {
			await expect(map.top).toBeGreaterThanOrEqual(discovery.bottom);
			await expect(map.bottom).toBeLessThanOrEqual(freshness.top);
		}
		await expect(canvas.getByLabelText('RTK range discovery')).toHaveTextContent('3 verified identities');
		const table = canvas.getByRole('table', { name: 'RTK base stations' });
		await expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
		await expect(table).toHaveTextContent('Mammotion RTK2');
		await expect(table).toHaveTextContent('Hops observed');
		await userEvent.click(within(table).getByRole('button', { name: /LoRa header 101:4242/ }));
		await expect(canvas.getByLabelText('Base station position')).toHaveTextContent('Waiting for the base');
		await userEvent.click(canvas.getByText('Decoder settings', { selector: 'summary' }));
		await expect(canvas.getByRole('combobox', { name: 'RTK signal profile' })).toHaveValue('scan');
		await expect(canvas.getByLabelText('RTK tracking VFOs')).toHaveTextContent('2 tracking VFOs');
		await expect(canvas.getByRole('checkbox', { name: 'Automatically track discovered RTK bases' })).toBeChecked();
		await expect(canvas.getByRole('spinbutton', { name: 'RTK discovery start MHz' })).toHaveValue(915);
		await expect(canvas.queryByRole('spinbutton', { name: 'RTK sample clock correction' })).toBeNull();
		await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
	},
};

export const RangeDiscoveryNarrow: Story = {
	render: () => ({ ...mockPanel(false, undefined, true), template: '<div style="width:320px;max-width:100%"><RtkPanel /></div>' }),
	play: RangeDiscovery.play,
};

export const OpenDiscoveredTracker: Story = {
	render: () => mockPanel(false, undefined, true),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			within(canvas.getByRole('table', { name: 'RTK base stations' })).getByRole('button', { name: /LoRa header 100:4242/ }),
		);
		await userEvent.click(canvas.getByRole('button', { name: 'Open tracking VFO' }));
		await expect(canvas.getByRole('combobox', { name: 'RTK VFO' })).toHaveValue('1');
		await expect(canvas.getByLabelText('GNSS receiver')).toHaveTextContent('MOCK GNSS A');
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
