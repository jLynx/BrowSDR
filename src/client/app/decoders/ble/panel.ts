import { computed, defineComponent, inject, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import * as components from '@/ui';
import { BLE_CHANNELS } from '@/worker/decoders/ble/packets';
import { manufacturerText } from './devices';
import { loadMacVendors } from './database';
import { macVendor } from './vendor-records';
import type { MacVendorDatabase } from './types';
import type { BleDevice } from '@/worker/decoders/ble/types';
import template from './panel.html?raw';

export default defineComponent({
	name: 'BlePanel',
	template,
	components,
	setup() {
		const receiver = inject<AppInstance>('receiver');
		if (!receiver) throw new Error('BlePanel requires a receiver');
		const query = ref(''),
			selected = ref(''),
			now = ref(Date.now());
		const vendors = shallowRef<MacVendorDatabase>();
		const databaseStatus = ref('Loading MAC vendor database…');
		watch(
			() => receiver.ble.panelOpen,
			async (open) => {
				if (!open || vendors.value) return;
				vendors.value = await loadMacVendors();
				databaseStatus.value = vendors.value ? 'MAC vendor database ready' : 'MAC vendor database unavailable';
			},
			{ immediate: true },
		);
		const vendorText = (device: BleDevice) =>
			device.addressType === 'random' ? 'Random address' : (macVendor(vendors.value, device) ?? 'Unknown');
		const timer = setInterval(() => {
			now.value = Date.now();
		}, 1000);
		onBeforeUnmount(() => clearInterval(timer));
		const devices = computed(() =>
			receiver.ble.devices.filter((device) => now.value - device.lastSeen < 300000).sort((a, b) => a.address.localeCompare(b.address)),
		);
		return {
			receiver,
			query,
			selected,
			now,
			channels: BLE_CHANNELS,
			manufacturerText,
			vendorText,
			databaseStatus,
			devices,
			selectedVfo: computed(() => receiver.vfos[receiver.activeVfoIndex]),
			filtered: computed(() =>
				devices.value.filter((device) =>
					`${device.address} ${device.name ?? ''} ${vendorText(device)} ${manufacturerText(device.manufacturer)} ${device.services.join(' ')}`
						.toLowerCase()
						.includes(query.value.toLowerCase()),
				),
			),
			selectedDevice: computed(() => devices.value.find((device) => `${device.addressType}:${device.address}` === selected.value)),
		};
	},
});
