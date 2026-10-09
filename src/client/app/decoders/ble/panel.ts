import { computed, defineComponent, inject, onBeforeUnmount, ref } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import * as components from '@/ui';
import { BLE_CHANNELS } from '@/worker/decoders/ble/packets';
import { manufacturerText } from './devices';
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
			devices,
			selectedVfo: computed(() => receiver.vfos[receiver.activeVfoIndex]),
			filtered: computed(() =>
				devices.value.filter((device) =>
					`${device.address} ${device.name ?? ''} ${manufacturerText(device.manufacturer)} ${device.services.join(' ')}`
						.toLowerCase()
						.includes(query.value.toLowerCase()),
				),
			),
			selectedDevice: computed(() => devices.value.find((device) => `${device.addressType}:${device.address}` === selected.value)),
		};
	},
});
