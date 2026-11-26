import { defineComponent, h, inject, shallowRef, watch } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import { emptyBandwidth } from '@/remote/bandwidth';
import UiBandwidth from '@/ui/indicators/UiBandwidth';

/** Isolate the once-per-second network updates from receiver and VFO rendering. */
export default defineComponent({
	name: 'RemoteBandwidth',
	setup() {
		const receiver = inject<AppInstance>('receiver')!;
		const snapshot = shallowRef(emptyBandwidth());
		watch(
			() => [receiver.remoteMode, receiver._webrtc?.bandwidth] as const,
			([mode, monitor], _previous, onCleanup) => {
				snapshot.value = emptyBandwidth();
				if (mode !== 'none' && monitor) onCleanup(monitor.subscribe((next) => (snapshot.value = next)));
			},
			{ immediate: true },
		);
		return () => h(UiBandwidth, { ...snapshot.value, host: receiver.remoteMode === 'host' });
	},
});
