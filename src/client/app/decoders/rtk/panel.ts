import { computed, defineComponent, inject, onBeforeUnmount, ref } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import * as components from '@/ui';
import template from './panel.html?raw';
import { referencePosition, signalStrength, loraNumber, loraPairingDetails } from './station-details';
import { downloadCorrections, downloadReport } from './downloads';
import { correctionAge, receptionState } from './reception';
import { useSatelliteObservations } from './signal-summary';
import { useBaseMap } from './map-view';
import { useStationSelection } from './station-selection';
import { usePairingEstimates } from './pairing-estimates';
import { stationKey } from '@/worker/decoders/rtk/station-key';
import { useDiscoveryControls } from './discovery-controls';

export default defineComponent({
	name: 'RtkPanel',
	template,
	components,
	setup() {
		const receiver = inject<AppInstance>('receiver')!;
		const mapElement = ref<HTMLElement>();
		const now = ref(Date.now()),
			exportFormat = ref('report');
		const timer = setInterval(() => (now.value = Date.now()), 1000);
		onBeforeUnmount(() => clearInterval(timer));
		const index = computed(() => receiver.activeVfoIndex);
		const vfo = computed(() => receiver.vfos[index.value]);
		const matching = computed(() => receiver.rtk.frequencies[index.value] === vfo.value?.freq);
		const status = computed(() => (matching.value ? (receiver.rtk.status[index.value] ?? undefined) : undefined));
		const selection = useStationSelection(receiver, now);
		const { station, frames, entry } = selection;
		const discovery = useDiscoveryControls(receiver, entry);
		const { scanning, scanError } = discovery;
		const effectiveProfile = computed(() =>
			scanning.value ? entry.value?.profile : vfo.value?.rtkProfile === 'auto' ? status.value?.detectedProfile : vfo.value?.rtkProfile,
		);
		const pairing = usePairingEstimates(station);
		const satellites = useSatelliteObservations(station, now, () => receiver.running && !!vfo.value?.rtk);
		const title = computed(() => (entry.value ? selection.stationTitle(entry.value) : 'RTK channel'));
		const position = computed(() => station.value?.reference);
		const identity = computed(() => `${vfo.value?.freq}:${station.value ? stationKey(station.value) : ''}:${position.value?.stationId}`);
		const mapView = useBaseMap(() => receiver.rtk.panelOpen, mapElement, position, identity, title);
		const reception = computed(() =>
			receptionState({
				running: receiver.running,
				enabled: !!vfo.value?.rtk,
				local: receiver.remoteMode !== 'client',
				inBand: scanning.value || (!!vfo.value && receiver.isFreqInBandwidth(vfo.value.freq)),
				status: status.value,
				station: station.value,
				now: now.value,
			}),
		);
		const presetFrequency = computed(() => {
			// Frequencies measured on this receiver; bases can select another channel.
			switch (vfo.value?.rtkProfile ?? 'rtk1') {
				case 'rtk1':
					return 923.118;
				case 'rtk2':
					return 915.191;
				default:
					return undefined;
			}
		});
		const canDownload = computed(() => (exportFormat.value === 'corrections' ? frames.value.length > 0 : !!station.value));
		return {
			...mapView,
			...selection,
			...pairing,
			...satellites,
			mapElement,
			receiver,
			vfo,
			status,
			effectiveProfile,
			...discovery,
			title,
			reception,
			correctionAge,
			now,
			presetFrequency,
			exportFormat,
			canDownload,
			referencePosition,
			loraNumber,
			loraPairingDetails,
			signalStrength,
			update: () => receiver.updateBackendVfoParams(index.value),
			changeProfile: () => {
				scanError.value = '';
				vfo.value.rtkFollowHops = false;
				if (vfo.value.rtkProfile !== 'auto' && vfo.value.rtkProfile !== status.value?.detectedProfile) vfo.value.rtkFollowSource = '';
				vfo.value.rtkClockPpm = vfo.value.rtkProfile === 'rtk3' ? 0 : vfo.value.rtkProfile === 'rtk1' ? 20 : 10;
				// Profile changes invalidate results even when the frequency stays the same.
				receiver.rtk.sources[index.value] = [];
				receiver.rtk.frames[index.value] = [];
				receiver.rtk.status[index.value] = null;
				receiver.updateBackendVfoParams(index.value);
			},
			exportData: () => {
				if (!canDownload.value) return;
				if (exportFormat.value === 'corrections')
					downloadCorrections(frames.value, entry.value?.frequency ?? vfo.value.freq, entry.value?.source);
				else
					downloadReport({
						frequency: entry.value?.frequency ?? vfo.value.freq,
						profile: vfo.value.rtkProfile ?? 'rtk1',
						status: status.value,
						stations: station.value ? [station.value] : [],
					});
			},
		};
	},
});
