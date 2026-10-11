import { Activity, Bluetooth, ChartNoAxesColumn, Mail, Mic, Plane, Radio, RadioTower, RotateCcw, Ship, Smartphone } from '@lucide/vue';
import { defineComponent, h, type PropType } from 'vue';
import type { UiIconName } from './icons.types';

/** Use the Lucide symbols selected in the approved tools preview. Named imports keep the bundle scoped to these icons. */
const icons = {
	microphone: Mic,
	pager: Smartphone,
	radio: Radio,
	sensors: RadioTower,
	aircraft: Plane,
	bluetooth: Bluetooth,
	vessel: Ship,
	message: Mail,
	stats: ChartNoAxesColumn,
	activity: Activity,
	reset: RotateCcw,
} satisfies Record<UiIconName, typeof Mic>;

export default defineComponent({
	name: 'UiIcon',
	props: { name: { type: String as PropType<UiIconName>, required: true }, size: { type: Number, default: 24 } },
	setup(props) {
		return () => h(icons[props.name], { size: props.size, strokeWidth: 2, 'aria-hidden': 'true' });
	},
});
