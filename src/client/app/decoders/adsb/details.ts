import { computed, defineComponent, inject, ref, watch, type PropType } from 'vue';
import type { Aircraft } from '@/worker/decoders/adsb/types';
import * as components from '@/ui';
import { hasLivePosition } from './aircraft';
import { aircraftClassification, DATABASE_SOURCE, lookupAircraft, lookupAirline } from './database/lookup';
import type { AircraftMetadata, AirlineMetadata, MetadataProvider } from './types';
import template from './details.html?raw';

export default defineComponent({
	name: 'AdsbDetails',
	components,
	template,
	props: {
		icao: { type: String, required: true },
		aircraft: Object as PropType<Aircraft>,
		now: { type: Number, required: true },
	},
	emits: ['close', 'metadata'],
	setup(props, { emit }) {
		const provider = inject<MetadataProvider>('aircraftMetadata', { lookupAircraft, lookupAirline });
		const metadata = ref<AircraftMetadata>();
		const airline = ref<AirlineMetadata>();
		const aircraftStatus = ref('');
		const airlineStatus = ref('');
		const retry = ref(0);
		watch(
			[() => props.icao, retry],
			async ([icao], _, onCleanup) => {
				let current = true;
				onCleanup(() => {
					current = false;
				});
				metadata.value = undefined;
				aircraftStatus.value = 'Loading aircraft database…';
				try {
					const record = await provider.lookupAircraft(icao);
					if (!current) return;
					metadata.value = record;
					if (record) emit('metadata', record);
					aircraftStatus.value = record ? '' : 'No aircraft record in this database.';
				} catch {
					if (current) aircraftStatus.value = 'Aircraft database unavailable. Check your internet connection and retry.';
				}
			},
			{ immediate: true },
		);
		watch(
			[() => props.aircraft?.callsign ?? '', retry],
			async ([callsign], _, onCleanup) => {
				let current = true;
				onCleanup(() => {
					current = false;
				});
				airline.value = undefined;
				airlineStatus.value = '';
				try {
					const record = await provider.lookupAirline(callsign);
					if (current) airline.value = record;
				} catch {
					if (current) airlineStatus.value = 'Airline database unavailable.';
				}
			},
			{ immediate: true },
		);
		return {
			metadata,
			airline,
			aircraftStatus,
			airlineStatus,
			retry,
			classification: computed(() => aircraftClassification(metadata.value?.type)),
			positioned: computed(() => !!props.aircraft && hasLivePosition(props.aircraft, props.now)),
			lastSeen: computed(() => (props.aircraft ? new Date(props.aircraft.lastSeen).toLocaleTimeString() : '—')),
			databaseSource: DATABASE_SOURCE,
		};
	},
});
