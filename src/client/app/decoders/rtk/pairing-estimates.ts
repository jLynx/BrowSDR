import { computed, ref } from 'vue';
import type { Ref } from 'vue';
import type { RtkStation } from '@/worker/decoders/rtk/types';
import { stationKey } from '@/worker/decoders/rtk/station-key';
import type { PairingEstimates, PairingField } from './types';

const storageKey = 'browsdr-rtk-pairing-estimates';
const fields = [
	{ field: 'scan', label: 'scan', max: 65535 },
	{ field: 'channel', label: 'channel', max: 255 },
	{ field: 'loc', label: 'local ID', max: 65535 },
	{ field: 'netId', label: 'network ID', max: 65535 },
] as const;

function validValue(value: unknown, max: number): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

function loadEstimates(): Record<string, PairingEstimates> {
	try {
		const saved: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}');
		if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
		const result: Record<string, PairingEstimates> = {};
		for (const [key, value] of Object.entries(saved).slice(-64)) {
			if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
			const entry = value as Record<string, unknown>;
			result[key] = {};
			for (const { field, max } of fields) if (validValue(entry[field], max)) result[key][field] = entry[field];
		}
		return result;
	} catch {
		return {};
	}
}

function decodedFields(station: RtkStation): PairingEstimates {
	// RTK2's currently validated header exposes only loc/net, even if stale
	// metadata from another profile contains scan/channel values.
	return station.protocol === 'rtk2'
		? { loc: station.loc, netId: station.address ?? station.netId }
		: { scan: station.scan, channel: station.channel, loc: station.loc, netId: station.netId };
}

export function usePairingEstimates(station: Ref<RtkStation | undefined>) {
	const estimates = ref(loadEstimates());
	const pairingParts = (base: RtkStation) => {
		if (base.address !== undefined && base.protocol !== 'rtk2') return [];
		if (base.protocol === 'rtk2' && base.loc === undefined) return [];
		const decoded = decodedFields(base);
		const saved = estimates.value[stationKey(base)] ?? {};
		return fields.map(({ field, label, max }) => ({
			field,
			label,
			max,
			decoded: decoded[field],
			value: decoded[field] ?? saved[field] ?? '?',
			estimated: decoded[field] === undefined && saved[field] !== undefined,
		}));
	};
	const hasPairingEstimates = (base: RtkStation) => pairingParts(base).some((part) => part.estimated);
	const estimatedFields = computed(() => (station.value ? pairingParts(station.value).filter((part) => part.decoded === undefined) : []));
	const setPairingEstimate = (field: PairingField, event: Event) => {
		if (!station.value) return;
		const part = pairingParts(station.value).find((part) => part.field === field && part.decoded === undefined);
		if (!part) return;
		const input = event.target as HTMLInputElement;
		const text = input.value.trim();
		const value = text === '' ? undefined : Number(text);
		if (value !== undefined && !validValue(value, part.max)) {
			input.value = part.estimated ? String(part.value) : '';
			return;
		}
		const key = stationKey(station.value);
		const updated = { ...estimates.value[key] };
		if (value === undefined) delete updated[field];
		else updated[field] = value;
		const remaining = Object.entries(estimates.value)
			.filter(([source]) => source !== key)
			.slice(-63);
		estimates.value = Object.fromEntries([...remaining, [key, updated]]);
		try {
			window.localStorage.setItem(storageKey, JSON.stringify(estimates.value));
		} catch {
			// The values still work for this panel when browser storage is unavailable.
		}
	};
	return { pairingParts, hasPairingEstimates, estimatedFields, setPairingEstimate };
}
