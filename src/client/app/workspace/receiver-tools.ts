import { computed, defineComponent, h, inject } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import { UiButton, UiIcon, UiMenu } from '@/ui';
import type { UiMenuGroup, UiMenuItem } from '@/ui/menus/types';

function toolGroups(receiver: AppInstance): UiMenuGroup[] {
	const vfos = receiver.vfos;
	return [
		{
			label: 'Decoders',
			items: [
				{
					id: 'whisper',
					label: 'Live Transcription',
					description: 'Speech to text · Whisper',
					icon: 'microphone',
					active: receiver.whisper.active,
					open: receiver.whisper.panelOpen,
				},
				{
					id: 'pocsag',
					label: 'POCSAG',
					description: 'Pager messages',
					icon: 'pager',
					active: vfos.some((vfo) => vfo.pocsag),
					open: receiver.pocsag.panelOpen,
				},
				{
					id: 'rds',
					label: 'FM RDS',
					description: 'FM station information',
					icon: 'radio',
					active: vfos.some((vfo) => vfo.rds && vfo.mode === 'wfm'),
					open: receiver.rds.panelOpen,
				},
				{
					id: 'rtl433',
					label: 'Wireless Sensors',
					description: 'Sensor & device data · rtl_433',
					icon: 'sensors',
					active: vfos.some((vfo) => vfo.rtl433),
					open: receiver.rtl433.panelOpen,
				},
				{
					id: 'adsb',
					label: 'ADS-B',
					description: 'Aircraft tracking',
					icon: 'aircraft',
					active: vfos.some((vfo) => vfo.adsb),
					open: receiver.adsb.panelOpen,
				},
				{
					id: 'ble',
					label: 'Bluetooth LE',
					description: 'Bluetooth devices',
					icon: 'bluetooth',
					active: vfos.some((vfo) => vfo.ble),
					open: receiver.ble.panelOpen,
				},
				{
					id: 'ais',
					label: 'AIS',
					description: 'Vessel tracking',
					icon: 'vessel',
					active: vfos.some((vfo) => vfo.ais),
					open: receiver.ais.panelOpen,
				},
				{
					id: 'acars',
					label: 'ACARS',
					description: 'Aircraft messages',
					icon: 'message',
					active: vfos.some((vfo) => vfo.acars),
					open: receiver.acars.panelOpen,
				},
			],
		},
		{
			label: 'Utilities',
			items: [
				{
					id: 'stats',
					label: 'DSP Stats',
					description: 'Receiver performance',
					icon: 'stats',
					active: receiver.showStats,
					open: receiver.showStats,
				},
				{
					id: 'activity',
					label: 'Frequency Activity',
					description: 'Signal activity over time',
					icon: 'activity',
					active: receiver.showActivity,
					open: receiver.showActivity,
				},
			],
		},
	];
}

function selectTool(receiver: AppInstance, id: string, openOnly = false): void {
	if (id === 'stats') receiver.showStats = !receiver.showStats;
	else if (id === 'activity') receiver.showActivity = !receiver.showActivity;
	else {
		const panels = {
			whisper: receiver.whisper,
			pocsag: receiver.pocsag,
			rds: receiver.rds,
			rtl433: receiver.rtl433,
			adsb: receiver.adsb,
			ble: receiver.ble,
			ais: receiver.ais,
			acars: receiver.acars,
		};
		const panel = panels[id as keyof typeof panels];
		if (panel) panel.panelOpen = openOnly || !panel.panelOpen;
	}
}

/** Own toolbar configuration reads here, outside the receiver and VFO telemetry renders. */
export default defineComponent({
	name: 'HeaderTools',
	setup() {
		const receiver = inject<AppInstance>('receiver')!;
		const groups = computed(() => toolGroups(receiver));
		const active = computed(() => groups.value[0].items.filter((item) => item.active));
		const shortcut = (item: UiMenuItem) =>
			h(
				UiButton,
				{
					key: item.id,
					variant: 'icon',
					class: 'active-decoder-tool active',
					'aria-label': `Open ${item.label} decoder`,
					title: `${item.label} · Decoding enabled`,
					onClick: () => selectTool(receiver, item.id, true),
				},
				() => [h(UiIcon, { name: item.icon, size: 20 }), h('span', item.label)],
			);
		return () =>
			h('div', { class: 'receiver-tools' }, [
				h('div', { class: 'active-decoder-tools', 'aria-label': 'Enabled decoders' }, active.value.map(shortcut)),
				h(UiMenu, {
					id: receiver.receiverId + '-header-tool-list',
					groups: groups.value,
					onSelect: (id: string) => selectTool(receiver, id),
				}),
			]);
	},
});
