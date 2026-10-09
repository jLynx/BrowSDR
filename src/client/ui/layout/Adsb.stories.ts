import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, within } from 'storybook/test';
import { computed, onBeforeUnmount, provide, reactive } from 'vue';
import AdsbPanel from '@/app/decoders/adsb/panel';
import { createAppData } from '@/app/core/state';
import { adsbMethods } from '@/app/decoders/adsb';
import { makeDefaultVfo } from '@/app/core/constants';
import type { AppInstance } from '@/app/core/receiver.types';

const meta = {
	title: 'Receiver/ADS-B Aircraft',
	component: AdsbPanel,
	parameters: {
		docs: { description: { component: 'Aircraft map and list with synthetic display fixtures; these are not received aircraft.' } },
	},
	render: () => ({
		components: { AdsbPanel },
		setup() {
			const now = Date.now();
			const receiver = reactive({
				...createAppData(),
				...adsbMethods,
				validateAndApplyVfoFreq: () => {},
				running: true,
				receiverId: 'adsb-story',
			});
			receiver.vfos = [{ ...makeDefaultVfo(1090), adsb: true }];
			receiver.adsb.panelOpen = true;
			receiver.adsb.status = [{ state: 'receiving', message: 'Synthetic display fixture', samples: 2000000, frames: 240 }];
			receiver.adsb.sources = [
				[
					{
						icao: 'ABC001',
						category: 3,
						callsign: 'DEMO101',
						altitude: 28000,
						speed: 420,
						heading: 45,
						latitude: -36.8,
						longitude: 174.7,
						positionTime: now,
						lastSeen: now,
						messages: 90,
					},
					{
						icao: 'ABC002',
						category: 7,
						callsign: 'DEMO202',
						altitude: 12000,
						speed: 250,
						heading: 180,
						latitude: -37,
						longitude: 174.9,
						positionTime: now,
						lastSeen: now,
						messages: 80,
					},
					{ icao: 'ABC003', altitude: 34000, lastSeen: now, messages: 70 },
				],
			];
			const timer = setInterval(() => {
				for (const aircraft of receiver.adsb.sources[0]) {
					aircraft.lastSeen = Date.now();
					if (aircraft.positionTime !== undefined) aircraft.positionTime = Date.now();
				}
			}, 1000);
			onBeforeUnmount(() => clearInterval(timer));
			provide('receiver', receiver as unknown as AppInstance);
			provide('aircraftMetadata', {
				lookupAircraft: (icao: string) =>
					Promise.resolve({
						registration: 'DEMO-01',
						manufacturer: 'Example manufacturer',
						model: 'Example model',
						type: icao === 'ABC002' ? 'H1T' : 'L2J',
						owner: 'Example owner',
						operator: 'Example operator',
					}),
				lookupAirline: () => Promise.resolve({ airline: 'Example airline', country: 'Example country' }),
			});
			return { count: computed(() => receiver.adsb.sources[0].length) };
		},
		template:
			'<div style="height:600px;display:flex;flex-direction:column;justify-content:flex-end"><p style="padding:12px">Synthetic aircraft fixture for map and layout review.</p><AdsbPanel /></div>',
	}),
} satisfies Meta<typeof AdsbPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AircraftMap: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const helicopter = await canvas.findByTitle('DEMO202');
		await userEvent.hover(helicopter);
		await expect(canvas.getByText('Ground speed')).toBeVisible();
		await expect(canvas.getByText('250 kt', { selector: 'dd' })).toBeVisible();
		const tooltip = canvas.getByRole('tooltip').getBoundingClientRect();
		const map = canvas.getByLabelText('Live aircraft map').getBoundingClientRect();
		await expect(tooltip.left).toBeGreaterThanOrEqual(map.left);
		await expect(tooltip.right).toBeLessThanOrEqual(map.right);
		await expect(tooltip.top).toBeGreaterThanOrEqual(map.top);
		await expect(tooltip.bottom).toBeLessThanOrEqual(map.bottom);
		await new Promise((resolve) => setTimeout(resolve, 1100));
		await expect(canvas.getByRole('tooltip')).toBeVisible();
		await userEvent.unhover(helicopter);
	},
};
export const AircraftDetails: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: 'DEMO101' }));
		await expect(canvas.getByLabelText('Aircraft details')).toBeVisible();
		await expect(canvas.getByText('Number of engines')).toBeVisible();
		await userEvent.click(canvas.getByRole('button', { name: 'Back to aircraft' }));
		await expect(canvas.getByRole('table')).toBeVisible();
	},
};
export const FullscreenMap: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: 'Fullscreen map' }));
		await expect(canvas.getByRole('button', { name: 'Exit fullscreen' })).toHaveAttribute('aria-pressed', 'true');
		const panel = canvas.getByRole('region', { name: 'ADS-B aircraft' });
		await expect(panel.getBoundingClientRect().height).toBe(window.innerHeight);
		await userEvent.keyboard('{Escape}');
		await expect(canvas.getByRole('button', { name: 'Fullscreen map' })).toHaveAttribute('aria-pressed', 'false');
	},
};
