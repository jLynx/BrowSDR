import { computed, defineComponent, inject, onBeforeUnmount, ref, type Ref } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import { APRS_CHANNELS, isAprsFrequency } from '@/worker/decoders/aprs';
import { APRS_PACKET_LIMIT, type AprsPacket } from '@/worker/decoders/aprs/types';
import * as components from '@/ui';
import { useAprsMap } from './map-view';
import { hasLiveStationPosition, kindLabel, motionText, packetSummary, stationKey, timestampText, visibleStations } from './stations';
import { stationDetails, telemetryDetails, weatherDetails } from './details';
import { symbolInfo } from './symbols';
import type { AprsLogEntry, AprsView } from './types';
import template from './panel.html?raw';

const KIND_FILTERS: Record<string, Array<AprsPacket['kind']>> = {
	position: ['position', 'object', 'item'],
	message: ['message'],
	weather: ['weather'],
	telemetry: ['telemetry'],
	status: ['status'],
	other: ['capabilities', 'query', 'other', 'ax25'],
};

/** Stations and packets from VFOs that are still decoding the frequency their snapshot came from. */
function useAprsLog(receiver: AppInstance, now: Ref<number>) {
	const sources = computed(() =>
		receiver.aprs.sources.flatMap((source, index) => {
			const vfo = receiver.vfos[index];
			return vfo?.aprs && source && source.freq === vfo.freq && isAprsFrequency(vfo.freq) ? [{ index, frequency: vfo.freq, source }] : [];
		}),
	);
	const stations = computed(() =>
		visibleStations(
			sources.value.map((item) => item.source.stations),
			now.value,
		),
	);
	const positioned = computed(() => stations.value.filter((item) => hasLiveStationPosition(item, now.value)));
	const packets = computed<AprsLogEntry[]>(() =>
		sources.value
			.flatMap(({ index, frequency, source }) =>
				source.packets.map((packet) => ({ ...packet, key: `${index}:${packet.id}`, vfoIndex: index, frequency })),
			)
			.sort((a, b) => b.receivedAt - a.receivedAt || a.vfoIndex - b.vfoIndex || b.id - a.id)
			.slice(0, APRS_PACKET_LIMIT),
	);
	return { stations, positioned, packets };
}

export default defineComponent({
	name: 'AprsPanel',
	template,
	components,
	setup() {
		const receiver = inject<AppInstance>('receiver');
		if (!receiver) throw new Error('AprsPanel requires a receiver');
		const now = ref(Date.now());
		const selected = ref('');
		const query = ref('');
		const kind = ref('all');
		const view = ref<AprsView>('stations');
		const channel = ref(APRS_CHANNELS[0].frequency);
		const error = ref('');
		const showMap = ref(true);
		const mapElement = ref<HTMLElement>();
		const timer = setInterval(() => {
			now.value = Date.now();
		}, 1000);
		onBeforeUnmount(() => clearInterval(timer));
		const { stations, positioned, packets } = useAprsLog(receiver, now);
		const matches = (text: string) => text.toLowerCase().includes(query.value.trim().toLowerCase());
		const filteredStations = computed(() =>
			stations.value.filter((item) =>
				matches(`${item.id} ${item.owner ?? ''} ${item.comment ?? ''} ${item.status ?? ''} ${symbolInfo(item.symbol).name}`),
			),
		);
		const filteredPackets = computed(() =>
			packets.value.filter(
				(item) =>
					(kind.value === 'all' || KIND_FILTERS[kind.value]?.includes(item.kind)) &&
					matches(`${item.source} ${item.destination} ${item.path.join(' ')} ${packetSummary(item)} ${item.info}`),
			),
		);
		const selectedStation = computed(() => stations.value.find((item) => stationKey(item) === selected.value));
		const stationPackets = computed(() => {
			const station = selectedStation.value;
			if (!station) return [];
			return packets.value
				.filter((item) =>
					station.type === 'station' ? item.source === station.id : item.kind === station.type && item.name === station.id,
				)
				.slice(0, 20);
		});
		const map = useAprsMap(receiver, showMap, mapElement, positioned, selected, error);
		return {
			receiver,
			now,
			selected,
			query,
			kind,
			view,
			channel,
			channels: APRS_CHANNELS,
			error,
			showMap,
			mapElement,
			stations,
			positioned,
			packets,
			filteredStations,
			filteredPackets,
			selectedStation,
			stationPackets,
			...map,
			details: computed(() => stationDetails(selectedStation.value, now.value)),
			weather: computed(() => weatherDetails(selectedStation.value?.weather)),
			telemetry: computed(() => telemetryDetails(selectedStation.value)),
			active: computed(() => receiver.vfos.some((vfo) => vfo.aprs)),
			selectedVfo: computed(() => receiver.vfos[receiver.activeVfoIndex]),
			isAprsFrequency,
			stationKey,
			symbolName: (symbol?: string) => symbolInfo(symbol).name,
			kindLabel,
			motionText,
			packetSummary,
			timestampText,
			hasLiveStationPosition,
			time: (timestamp: number) => new Date(timestamp).toLocaleTimeString(),
			heard: (timestamp: number) => {
				const seconds = Math.max(0, Math.floor((now.value - timestamp) / 1000));
				return seconds < 120 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
			},
			showStation: (key: string) => {
				view.value = 'stations';
				map.select(key);
			},
		};
	},
});
