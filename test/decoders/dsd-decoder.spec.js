import { describe, expect, it, vi } from 'vitest';

vi.mock('@/worker/decoders/mbelib-init', () => ({
	ensureMbelibInitialized: async () => {},
	decodeAmbe: () => new Float32Array(160),
	decodeImbe: () => new Float32Array(160),
	resetMbe: vi.fn(),
	getMbeErrors: () => 0,
}));

import { DSDDecoder } from '@/worker/decoders/dsd/dsd-decoder';
import { FIRFilter, rrcTaps } from '@/worker/decoders/dsd/dsd-dsp';
import { RRC_NUM_TAPS, RRC_ALPHA, SYNC_WORDS } from '@/worker/decoders/dsd/constants';

function randomDibits(length) {
	let seed = 123456789;
	return Uint8Array.from({ length }, () => {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return seed & 3;
	});
}

function waveform(dibits) {
	const impulses = new Float32Array(dibits.length * 10 + 100);
	const levels = [1, 3, -1, -3];
	for (let i = 0; i < dibits.length; i++) impulses[i * 10] = levels[dibits[i]] * 0.25;
	const result = new Float32Array(impulses.length);
	new FIRFilter(rrcTaps(RRC_NUM_TAPS, 48000, 4800, RRC_ALPHA)).process(impulses, result);
	return result;
}

function receive(dibits, chunk = 1567) {
	const statuses = [];
	const decoder = new DSDDecoder(
		() => {},
		(status) => statuses.push(status),
	);
	const samples = waveform(dibits);
	for (let i = 0; i < samples.length; i += chunk) decoder.process(samples.subarray(i, i + chunk));
	return { decoder, statuses };
}

describe('DSD acquisition', () => {
	it('acquires a pulse-shaped DMR repeater signal across USB chunks', () => {
		const dibits = randomDibits(144 * 100);
		for (let burst = 0; burst < 100; burst++) {
			dibits.set(Uint8Array.from(SYNC_WORDS.DMR_BS_DATA, Number), burst * 144 + 66);
		}
		const statuses = receive(dibits).statuses.filter((s) => s.synced);
		expect(statuses.filter((s) => s.mode === 'dmr').length).toBeGreaterThan(90);
		expect(statuses.every((s) => s.mode === 'dmr')).toBe(true);
	});
	it('does not declare a receiver locked from one accidental sync', () => {
		const statuses = [];
		const decoder = new DSDDecoder(
			() => {},
			(status) => statuses.push(status),
		);
		for (const dibit of SYNC_WORDS.DMR_BS_VOICE) decoder.feedDibit(Number(dibit));
		expect(statuses.some((s) => s.synced)).toBe(false);
	});
	it('confirms voice syncs one DMR superframe apart before reading speech', () => {
		const statuses = [];
		const decoder = new DSDDecoder(
			() => {},
			(status) => statuses.push(status),
		);
		for (const dibit of SYNC_WORDS.DMR_BS_VOICE) decoder.feedDibit(Number(dibit));
		for (let i = 0; i < 1728 - 24; i++) decoder.feedDibit(0);
		for (const dibit of SYNC_WORDS.DMR_BS_VOICE) decoder.feedDibit(Number(dibit));
		expect(statuses.at(-1)).toMatchObject({ mode: 'dmr', synced: true, syncName: 'DMR_BS_VOICE' });
	});
	it('expires sync and clears voice status when the carrier ends', () => {
		const dibits = new Uint8Array(144 * 20);
		for (let burst = 0; burst < 20; burst++) dibits.set(Uint8Array.from(SYNC_WORDS.DMR_BS_DATA, Number), burst * 144 + 66);
		const { decoder, statuses } = receive(dibits);
		expect(statuses.some((s) => s.synced)).toBe(true);
		for (let i = 0; i < 40; i++) decoder.process(new Float32Array(1567));
		expect(statuses.at(-1)).toMatchObject({ mode: 'unknown', synced: false, mbeDecoding: false });
		expect(statuses.at(-1).syncCount).toBeGreaterThan(0);
		expect(statuses.at(-1).lastSyncName).toBe('DMR_BS_DATA');
		decoder.reset();
		expect(statuses.at(-1).syncCount || 0).toBe(0);
		expect(statuses.at(-1).lastSyncName).toBeUndefined();
	});
});
