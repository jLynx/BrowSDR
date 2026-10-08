import type { Bookmark } from './types';
import type { Vfo } from '@/app/core/types';
import { makeDefaultVfo } from '@/app/core/constants';

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function vfoFromData(value: unknown): Vfo {
	if (!record(value) || typeof value.freq !== 'number' || !Number.isFinite(value.freq)) throw new Error('Invalid bookmark frequency');
	const defaults = makeDefaultVfo(value.freq);
	for (const key of Object.keys(defaults) as Array<keyof Vfo>) {
		if (
			value[key] !== undefined &&
			(typeof value[key] !== typeof defaults[key] || (typeof value[key] === 'number' && !Number.isFinite(value[key])))
		)
			throw new Error(`Invalid bookmark field: ${key}`);
	}
	// Every supplied VFO field has been checked against its default's runtime type.
	return { ...defaults, ...value };
}

export function parseBookmarks(json: string): Bookmark[] {
	const values: unknown = JSON.parse(json);
	if (!Array.isArray(values)) throw new Error('Expected a bookmark array');
	return values.map((value: unknown) => {
		if (!record(value) || typeof value.name !== 'string') throw new Error('Invalid bookmark name');
		const common = {
			name: value.name,
			...(typeof value.category === 'string' ? { category: value.category } : {}),
			...(typeof value.id === 'string' ? { id: value.id } : {}),
		};
		if (value.type === 'individual') return { ...vfoFromData(value), ...common, type: 'individual' };
		validateGroupFields(value);
		validateGroupSelection(value);
		return {
			...common,
			type: 'group',
			...(typeof value.centerFreq === 'number' ? { centerFreq: value.centerFreq } : {}),
			...(typeof value.sampleRate === 'number' ? { sampleRate: value.sampleRate } : {}),
			...(Array.isArray(value.vfos) ? { vfos: value.vfos.map(vfoFromData) } : {}),
			...(typeof value.activeVfoIndex === 'number' ? { activeVfoIndex: value.activeVfoIndex } : {}),
		};
	});
}

function validateGroupFields(value: Record<string, unknown>): void {
	for (const key of ['centerFreq', 'sampleRate']) {
		if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key])))
			throw new Error(`Invalid bookmark group field: ${key}`);
	}
	if (value.vfos !== undefined && !Array.isArray(value.vfos)) throw new Error('Invalid bookmark group');
}

function validateGroupSelection(value: Record<string, unknown>): void {
	if (Array.isArray(value.vfos) && value.vfos.length === 0) throw new Error('Bookmark group needs at least one VFO');
	const index = value.activeVfoIndex;
	if (index === undefined) return;
	if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || !Array.isArray(value.vfos) || index >= value.vfos.length)
		throw new Error('Invalid active bookmark VFO index');
}
