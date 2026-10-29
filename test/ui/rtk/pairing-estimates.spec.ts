import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, toRaw } from 'vue';
import type { RtkStation } from '@/worker/decoders/rtk/types';
import { usePairingEstimates } from '@/app/decoders/rtk/pairing-estimates';
import { mockStation, mockPairingStorage } from './fixtures';

const storageKey = 'browsdr-rtk-pairing-estimates';
beforeEach(() => vi.stubGlobal('localStorage', mockPairingStorage()));
afterEach(() => vi.unstubAllGlobals());

function change(value: string) {
	const input = document.createElement('input');
	input.value = value;
	const event = new Event('change');
	Object.defineProperty(event, 'target', { value: input });
	return event;
}

function setup() {
	const station = ref<RtkStation | undefined>({
		...mockStation(),
		protocol: 'rtk2',
		network: '3030303030303030',
		loc: 0,
		address: 42,
	});
	return { station, pairing: usePairingEstimates(station) };
}

describe('RTK pairing estimates', () => {
	it('fills only unknown RTK2 fields and preserves decoded zero and the station payload', () => {
		const { station, pairing } = setup();
		const original = structuredClone(toRaw(station.value));
		pairing.setPairingEstimate('scan', change('903'));
		pairing.setPairingEstimate('channel', change('7'));
		pairing.setPairingEstimate('loc', change('99'));
		pairing.setPairingEstimate('netId', change('99'));
		expect(pairing.pairingParts(station.value!).map((p) => [p.value, p.estimated])).toEqual([
			[903, true],
			[7, true],
			[0, false],
			[42, false],
		]);
		expect(station.value).toEqual(original);
		expect(pairing.estimatedFields.value.map((p) => p.field)).toEqual(['scan', 'channel']);
	});

	it('retains estimates for the same radio identity across retuning and panel remount, but not for another base', () => {
		const { station, pairing } = setup();
		pairing.setPairingEstimate('scan', change('903'));
		station.value = { ...station.value!, lastSeen: Date.now() + 1 };
		expect(pairing.pairingParts(station.value!)[0]).toMatchObject({ value: 903, estimated: true });
		expect(usePairingEstimates(station).pairingParts(station.value!)[0]).toMatchObject({ value: 903, estimated: true });
		station.value = { ...station.value!, address: 43, netId: 43 };
		expect(pairing.pairingParts(station.value!)[0]).toMatchObject({ value: '?', estimated: false });
	});

	it('supports a zero RTK1 estimate, clearing it, and replacing it with a decoded value', () => {
		const station = ref<RtkStation | undefined>(mockStation());
		const pairing = usePairingEstimates(station);
		pairing.setPairingEstimate('loc', change('0'));
		expect(pairing.pairingParts(station.value!)[2]).toMatchObject({ value: 0, estimated: true });
		station.value = { ...station.value!, loc: 42 };
		expect(pairing.pairingParts(station.value!)[2]).toMatchObject({ value: 42, estimated: false });
		station.value = { ...station.value!, loc: undefined };
		pairing.setPairingEstimate('loc', change(''));
		expect(pairing.pairingParts(station.value!)[2]).toMatchObject({ value: '?', estimated: false });
	});

	it.each(['-1', '1.5', '65536', 'NaN', 'Infinity'])('rejects invalid scan estimate %s', (value) => {
		const { station, pairing } = setup();
		pairing.setPairingEstimate('scan', change('903'));
		const event = change(value);
		pairing.setPairingEstimate('scan', event);
		expect(pairing.pairingParts(station.value!)[0].value).toBe(903);
		expect((event.target as HTMLInputElement).value).toBe('903');
	});

	it('validates channel limits and malformed stored data without inventing missing values', () => {
		window.localStorage.setItem(
			storageKey,
			JSON.stringify({
				'rtk2-3030303030303030-42': { scan: '903', channel: 256, loc: -1, netId: 99 },
			}),
		);
		const { station, pairing } = setup();
		pairing.setPairingEstimate('channel', change('256'));
		expect(pairing.pairingParts(station.value!).map((p) => p.value)).toEqual(['?', '?', 0, 42]);
		window.localStorage.setItem(storageKey, 'broken json');
		expect(usePairingEstimates(station).hasPairingEstimates(station.value!)).toBe(false);
	});

	it('does not turn an RTK3 address or an unparsed RTK2 loc into a four-part decoded number', () => {
		const { station, pairing } = setup();
		station.value = { ...mockStation(), address: 42 };
		expect(pairing.estimatedFields.value).toEqual([]);
		expect(pairing.pairingParts(station.value)).toEqual([]);
		station.value = { ...mockStation(), protocol: 'rtk2', address: 42 };
		expect(pairing.pairingParts(station.value)).toEqual([]);
	});
});
