import { describe, expect, it } from 'vitest';
import { detectSignals } from '@/worker/discovery/detector';
import { SignalTracker } from '@/worker/discovery/tracker';
import type { DiscoveryConfig } from '@/worker/discovery/types';

const config: DiscoveryConfig = { centerHz: 130e6, sampleRate: 20e6, thresholdDb: 10, minWidthHz: 0, excludeDc: true };
function fixture() {
	const data = new Float32Array(65536);
	for (let i = 0; i < data.length; i++) data[i] = -100 + 2 * Math.sin(i * 0.73) + (6 * i) / data.length;
	return data;
}
function signal(data: Float32Array, start: number, end: number) {
	for (let i = start; i <= end; i++) data[i] += 24;
}

describe('wideband signal discovery', () => {
	it('holds a rounded frequency while matching changing signal edges internally', () => {
		const tracker = new SignalTracker();
		const binHz = config.sampleRate / 65536;
		const options = { ...config, centerHz: 106.2e6 - (20100 - 32768) * binHz + 5000 };
		const data = fixture();
		signal(data, 20000, 20200);
		const first = tracker.process({ data, config: options, time: 1000 }).signals[0];
		const id = first.id;
		expect(first.frequencyHz).toBe(106.2e6);
		const shifted = fixture();
		signal(shifted, 20002, 20202);
		for (let i = 1; i <= 10; i++) {
			const entries = tracker.process({ data: shifted, config: options, time: 1000 + i * 100 }).signals;
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ id, frequencyHz: 106.2e6, active: true });
		}
	});
	it('rejects narrow fluctuations on a raised local noise floor while retaining a real carrier', () => {
		const data = new Float32Array(65536).fill(-100);
		data.fill(-94, 19500, 20500);
		data.set([-92, -89, -89, -92], 20000);
		const options = { ...config, sampleRate: 5e6 };
		expect(detectSignals(data, options)).toEqual([]);
		data.set([-86, -82, -86], 20100);
		const detections = detectSignals(data, options);
		expect(detections).toHaveLength(1);
		expect(detections[0].aboveNoiseDb).toBeCloseTo(12);
	});
	it('does not confirm unrelated weak hits seconds apart or refresh from nearby noise', () => {
		const tracker = new SignalTracker();
		const data = new Float32Array(65536).fill(-100);
		data.set([-92, -88, -92], 29678);
		const options = { ...config, sampleRate: 5e6 };
		expect(tracker.process({ data, config: options, time: 1000 }).signals).toEqual([]);
		expect(tracker.process({ data, config: options, time: 5000 }).signals).toEqual([]);
		const confirmed = tracker.process({ data, config: options, time: 5100 }).signals[0];
		const frequency = confirmed.frequencyHz;
		const noise = new Float32Array(65536).fill(-100);
		noise[29683] = -92;
		const latest = tracker.process({ data: noise, config: options, time: 5200 }).signals[0];
		expect(latest).toMatchObject({ active: false, lastSeen: 5100, frequencyHz: frequency });
	});
	it('refreshes confirmed carriers below the discovery threshold and stops when they disappear', () => {
		const tracker = new SignalTracker();
		const data = new Float32Array(65536).fill(-100);
		data.set([-92, -88, -92], 29678);
		const options = { ...config, sampleRate: 5e6 };
		tracker.process({ data, config: options, time: 1000 });
		const id = tracker.process({ data, config: options, time: 1100 }).signals[0].id;
		data.set([-98, -91, -98], 29678);
		// A similarly weak carrier elsewhere must not become a new entry.
		data.set([-98, -91, -98], 40000);
		const refreshed = tracker.process({ data, config: options, time: 40000 }).signals;
		expect(refreshed).toHaveLength(1);
		expect(refreshed[0]).toMatchObject({ id, active: true, lastSeen: 40000, hits: 3 });
		expect(new SignalTracker().process({ data, config: options, time: 40000 }).signals).toEqual([]);
		const silent = tracker.process({ data: new Float32Array(65536).fill(-100), config: options, time: 41000 });
		expect(silent.signals[0]).toMatchObject({ id, active: false, lastSeen: 40000 });
	});
	it('keeps a narrow carrier live with one threshold bin and nearby isolated noise', () => {
		const tracker = new SignalTracker();
		const data = new Float32Array(65536).fill(-100);
		// Nuttall-window carrier: one peak over 10 dB, two shoulders over 7 dB.
		data[29678] = -92;
		data[29679] = -88;
		data[29680] = -92;
		data[29700] = -92;
		const options = { ...config, sampleRate: 5e6 };
		expect(tracker.process({ data, config: options, time: 1000 }).signals).toEqual([]);
		const second = tracker.process({ data, config: options, time: 1100 }).signals;
		expect(second).toHaveLength(1);
		const id = second[0].id;
		const latest = tracker.process({ data, config: options, time: 40000 }).signals;
		expect(latest).toHaveLength(1);
		expect(latest[0].id).toBe(id);
		expect(latest[0].active).toBe(true);
		expect(latest[0].lastSeen).toBe(40000);
		expect(latest[0].widthHz).toBeCloseTo((3 * 5e6) / 65536);
	});
	it('rejects sparse noise peaks joined by the 3 kHz notch allowance at 5 MSPS', () => {
		const data = new Float32Array(65536).fill(-100);
		for (let i = 20000; i < 20400; i += 20) {
			data[i] = -88;
			data[i + 1] = -91;
		}
		expect(detectSignals(data, { ...config, sampleRate: 5e6 })).toEqual([]);
	});
	it('confirms weak detections on a second frame but keeps strong single bursts', () => {
		const tracker = new SignalTracker();
		const data = new Float32Array(65536).fill(-100);
		data.fill(-88, 20000, 20004);
		expect(tracker.process({ data, config, time: 1000 }).signals).toEqual([]);
		const confirmed = tracker.process({ data, config, time: 1100 }).signals;
		expect(confirmed).toHaveLength(1);
		expect(confirmed[0].hits).toBe(2);
		const isolated = new SignalTracker();
		expect(isolated.process({ data, config, time: 1000 }).signals).toEqual([]);
		expect(isolated.process({ data: fixture(), config, time: 1100 }).signals).toEqual([]);
		data.fill(-76, 30000, 30004);
		expect(new SignalTracker().process({ data, config, time: 1000 }).signals).toHaveLength(1);
	});
	it('rejects a varying noise floor, nonfinite bins and excluded receiver artifacts', () => {
		const data = fixture();
		data[1200] = NaN;
		data[1400] = Infinity;
		signal(data, 1, 8);
		signal(data, 32766, 32770);
		expect(detectSignals(data, config)).toEqual([]);
		expect(detectSignals(data, { ...config, excludeDc: false })).toHaveLength(1);
	});
	it('finds narrow and broad signals with frequency and width independent of display contrast', () => {
		const data = fixture();
		signal(data, 10000, 10007);
		signal(data, 20000, 20600);
		const results = detectSignals(data, config);
		expect(results).toHaveLength(2);
		expect(results[0].frequencyHz).toBeCloseTo(120e6 + (10003.5 * 20e6) / 65536);
		expect(results[0].widthHz).toBeCloseTo((8 * 20e6) / 65536);
		expect(results[1].widthHz).toBeCloseTo((601 * 20e6) / 65536);
		expect(
			detectSignals(
				data.map((value) => value + 25),
				config,
			),
		).toEqual(results);
		expect(detectSignals(data, { ...config, minWidthHz: 6000 })).toHaveLength(1);
	});
	it('bridges small spectral notches but keeps neighbouring channels separate', () => {
		const data = fixture();
		signal(data, 10000, 10010);
		signal(data, 10013, 10025);
		signal(data, 10040, 10050);
		expect(detectSignals(data, config)).toHaveLength(2);
	});
	it('retains a burst through silence, matches it again and expires old history', () => {
		const tracker = new SignalTracker();
		const data = fixture();
		signal(data, 10000, 10010);
		const first = tracker.process({ data, config, time: 1000 }).signals[0];
		const silent = tracker.process({ data: fixture(), config, time: 2000 }).signals[0];
		expect(silent.active).toBe(false);
		expect(silent.hits / silent.observations).toBe(0.5);
		const repeated = tracker.process({ data, config, time: 3000 }).signals;
		expect(repeated).toHaveLength(1);
		expect(repeated[0].id).toBe(first.id);
		expect(repeated[0].hits).toBe(2);
		expect(tracker.process({ data: fixture(), config, time: 123001 }).signals).toHaveLength(0);
	});
	it('keeps a modulated signal together across kilohertz notches and changing width', () => {
		const data = fixture();
		signal(data, 20000, 20200);
		signal(data, 20207, 20400);
		expect(detectSignals(data, config)).toHaveLength(1);
		const tracker = new SignalTracker();
		const first = tracker.process({ data, config, time: 1000 }).signals[0];
		const narrowed = fixture();
		signal(narrowed, 20050, 20230);
		const second = tracker.process({ data: narrowed, config, time: 1100 }).signals;
		expect(second).toHaveLength(1);
		expect(second[0].id).toBe(first.id);
	});
	it('retains one identity when overlapping 3.7 kHz estimates move about 2.7 kHz', () => {
		const tracker = new SignalTracker();
		const left = fixture();
		const right = fixture();
		// Mirrors the reported 133.676862 / 133.679529 MHz pair: 9 bins apart.
		signal(left, 44811, 44822);
		signal(right, 44820, 44831);
		const first = tracker.process({ data: left, config, time: 1000 }).signals[0];
		const id = first.id;
		const frequency = first.frequencyHz;
		tracker.process({ data: fixture(), config, time: 1100 });
		const second = tracker.process({ data: right, config, time: 1200 }).signals;
		expect(second).toHaveLength(1);
		expect(second[0].id).toBe(id);
		expect(second[0].firstSeen).toBe(1000);
		expect(second[0].lastSeen).toBe(1200);
		expect(second[0].hits).toBe(2);
		expect(second[0].observations).toBe(3);
		expect(Math.abs(second[0].frequencyHz - frequency)).toBeLessThan(1000);
	});
	it('preserves separate nearby channels visible in the same frame', () => {
		const tracker = new SignalTracker();
		const data = fixture();
		signal(data, 44800, 44811);
		signal(data, 44830, 44841);
		const ids = tracker.process({ data, config, time: 1000 }).signals.map((entry) => entry.id);
		const shifted = fixture();
		signal(shifted, 44804, 44815);
		signal(shifted, 44826, 44837);
		const entries = tracker.process({ data: shifted, config, time: 1100 }).signals;
		expect(entries.map((entry) => entry.id)).toEqual(ids);
		expect(entries.every((entry) => entry.hits === 2)).toBe(true);
	});
});
