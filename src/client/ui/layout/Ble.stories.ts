import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, within } from 'storybook/test';
import { provide, reactive } from 'vue';
import BlePanel from '@/app/decoders/ble/panel';
import { createAppData } from '@/app/core/state';
import { makeDefaultVfo } from '@/app/core/constants';
import type { AppInstance } from '@/app/core/receiver.types';
import type { BleDevice } from '@/worker/decoders/ble/types';

const meta = {
	title: 'Receiver/BLE Devices',
	component: BlePanel,
	parameters: { docs: { description: { component: 'Passive BLE device list with synthetic advertisements for layout review.' } } },
	render: () => ({
		components: { BlePanel },
		setup() {
			const data = createAppData();
			const packet: BleDevice = {
				address: 'C6:05:04:03:02:01',
				addressType: 'random',
				name: 'Demo temperature sensor',
				completeName: true,
				pduType: 'ADV_IND',
				channel: 37,
				channels: [37, 38, 39],
				manufacturer: 0x0059,
				manufacturerData: '1234567890ABCDEF',
				services: ['180F', '181A'],
				serviceData: ['181A: 123456'],
				data: '02010603030F18090944656D6F',
				signalDbfs: -24.8,
				txPower: -4,
				firstSeen: Date.now(),
				lastSeen: Date.now(),
				packets: 123,
			};
			const receiver = reactive({
				...data,
				vfos: [{ ...makeDefaultVfo(2402), ble: true }],
				running: true,
				ble: {
					...data.ble,
					panelOpen: true,
					devices: [
						packet,
						{ ...packet, address: '00:11:22:33:44:55', name: undefined, addressType: 'public', manufacturer: 76, signalDbfs: -48.1 },
					],
				},
				toggleBlePanel: () => {},
				updateBackendVfoParams: () => {},
				tuneBleChannel: () => Promise.resolve(true),
				startBleScan: () => Promise.resolve(),
				stopBleScan: () => {},
				showMsg: () => {},
				clearBleDevices() {
					receiver.ble.devices = [];
				},
			});
			provide('receiver', receiver as unknown as AppInstance);
		},
		template: '<div style="padding-top:20px"><p>Synthetic BLE advertisements for display review.</p><BlePanel /></div>',
	}),
} satisfies Meta<typeof BlePanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Preview: Story = {};
export const DeviceList: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(canvas.getByLabelText('Search BLE devices'), 'temperature');
		await expect(canvas.getAllByRole('row')).toHaveLength(2);
		await userEvent.click(canvas.getByRole('button', { name: 'Demo temperature sensor' }));
		await expect(canvas.getByLabelText('BLE device details')).toBeVisible();
		await expect(canvas.getByText('180F, 181A')).toBeVisible();
		await userEvent.click(canvas.getByRole('button', { name: 'Back to devices' }));
		await userEvent.click(canvas.getByRole('button', { name: 'Clear devices' }));
		await expect(canvas.getByText(/Waiting for BLE advertisements/)).toBeVisible();
	},
};
