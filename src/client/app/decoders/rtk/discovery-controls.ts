import { computed, ref } from 'vue';
import type { ComputedRef } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { RtkStationEntry } from './types';
import { surveyPlan } from '@/worker/decoders/rtk/discovery/plan';
import { errorMessage } from '@/platform/errors';

export function useDiscoveryControls(receiver: AppInstance, entry: ComputedRef<RtkStationEntry | undefined>) {
	const index = computed(() => receiver.activeVfoIndex);
	const vfo = computed(() => receiver.vfos[index.value]);
	const scanError = ref('');
	const applyScan = () => {
		try {
			surveyPlan(vfo.value.rtkScanStart ?? 915, vfo.value.rtkScanEnd ?? 928, receiver.radio.sampleRate, receiver.radio.centerFreq);
			scanError.value = '';
			vfo.value.rtk = true;
			receiver.updateBackendVfoParams(index.value);
		} catch (error) {
			scanError.value = errorMessage(error);
		}
	};
	return {
		scanning: computed(() => vfo.value?.rtkProfile === 'scan'),
		scanError,
		applyScan,
		useReceivedBand: () => {
			vfo.value.rtkScanStart = Math.max(900, Math.ceil((receiver.radio.centerFreq - receiver.radio.sampleRate / 2e6 + 0.3) * 1000) / 1000);
			vfo.value.rtkScanEnd = Math.min(930, Math.floor((receiver.radio.centerFreq + receiver.radio.sampleRate / 2e6 - 0.3) * 1000) / 1000);
			applyScan();
		},
		followDiscovered: () => {
			if (!entry.value) return;
			const { frequency, source } = entry.value;
			vfo.value.rtkProfile = 'auto';
			vfo.value.rtkFollowSource = source;
			vfo.value.rtkFollowHops = false;
			receiver.rtk.sources[index.value] = [];
			receiver.rtk.status[index.value] = null;
			receiver.rtk.frames[index.value] = [];
			receiver.tuneRtkVfo(frequency);
		},
	};
}
