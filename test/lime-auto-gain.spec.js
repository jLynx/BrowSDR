import { afterEach, describe, expect, it, vi } from 'vitest';
import { reactive, nextTick } from 'vue';
import { LimeRxLevel } from '../src/client/devices/lime-rx-level';
import { limeGainProfile, limeGainTotal, nextLimeGain } from '../src/client/lime-auto-gain';
import { autoGainMethods } from '../src/client/app/auto-gain';

afterEach(() => vi.useRealTimers());
const level = (rmsDbfs = -22, peakDbfs = -8, clippedFraction = 0) => ({ started: Date.now() - 250, timestamp: Date.now(), samples: 800, rmsDbfs, peakDbfs, clippedFraction });
const starting = { LNA: 15, TIA: 2, PGA: 16 };

describe('LimeSDR raw ADC level', () => {
	it('excludes packet headers and measures original ADC amplitude and clipping', () => {
		const meter = new LimeRxLevel();
		const data = new DataView(new ArrayBuffer(8192));
		for (let offset = 0; offset < 8192; offset += 2) data.setInt16(offset, 32752, true);
		for (let packet = 0; packet < 8192; packet += 4096)
			for (let offset = packet + 16; offset < packet + 4096; offset += 2) data.setInt16(offset, -16384, true);
		meter.reset(1000); meter.observe(data, 1250);
		expect(meter.level.rmsDbfs).toBeCloseTo(-6.0206);
		expect(meter.level.peakDbfs).toBeCloseTo(-6.0206);
		expect(meter.level.clippedFraction).toBe(0);
		for (let offset = 0; offset < 8192; offset += 2) data.setInt16(offset, -32768, true);
		meter.observe(data, 1500);
		expect(meter.level.clippedFraction).toBe(1);
		meter.reset(1501); expect(meter.level).toBeNull();
	});
});
describe('automatic LimeSDR gain staging', () => {
	it('honors discrete gain steps and physical gain limits', () => {
		for (let total = -12; total <= 61; total++) {
			const gains = limeGainProfile(total);
			expect(limeGainTotal(gains)).toBe(total);
			expect(gains.LNA).toBeGreaterThanOrEqual(0); expect(gains.LNA).toBeLessThanOrEqual(30);
			expect(gains.TIA).toBeGreaterThanOrEqual(0); expect(gains.TIA).toBeLessThanOrEqual(2);
			expect(gains.PGA).toBeGreaterThanOrEqual(0); expect(gains.PGA).toBeLessThanOrEqual(31);
		}
		expect(limeGainTotal({ LNA: 14, TIA: 2, PGA: 16 })).toBe(28);
	});
	it('backs off clipping quickly, raises weak levels slowly and leaves stable levels fixed', () => {
		expect(limeGainTotal(nextLimeGain(starting, level(-12, -0.1, 0.01)).gains)).toBe(limeGainTotal(starting) - 6);
		expect(limeGainTotal(nextLimeGain(starting, level(-45, -20)).gains)).toBe(limeGainTotal(starting) + 3);
		expect(nextLimeGain(starting, level()).done).toBe(true);
		expect(nextLimeGain(starting, level(-40, -5)).done).toBe(true); // strong peaks constrain weak RMS
		expect(nextLimeGain(limeGainProfile(61), level(-45, -20)).reason).toBe('Gain limit reached');
		expect(() => nextLimeGain(starting, level(-120, -120))).toThrow('samples are silent');
	});
});
function appWithLevel(readLevel = () => level()) {
	vi.useFakeTimers();
	return reactive({ ...autoGainMethods, autoGain: { active: false, status: '', level: null },
		gains: { ...starting, Antenna: 1, 'RX Channel': 0 },
		radio: { centerFreq: 30, sampleRate: 61440000, frequencyShift: 0 },
		vfos: [{ enabled: false, volume: 0 }],
		running: true, connected: true, remoteMode: 'none', deviceCapabilities: { deviceType: 'limesdr' },
		saveSetting: vi.fn(), $nextTick: nextTick,
		backend: { setGains: vi.fn().mockResolvedValue(undefined), setGain: vi.fn().mockResolvedValue(undefined), getRxLevel: vi.fn(readLevel) },
	});
}
describe('one-shot gain adjustment lifecycle', () => {
	it('uses fresh measurements and holds settled gains with muted VFOs', async () => {
		const app = appWithLevel();
		const run = app.autoSetGains();
		expect(app.autoGain.active).toBe(true);
		await vi.advanceTimersByTimeAsync(3000); await run;
		expect(app.backend.setGain).not.toHaveBeenCalled();
		expect(app.autoGain.status).toBe('Levels settled'); expect(app.autoGain.active).toBe(false);
		expect(app.vfos[0]).toMatchObject({ enabled: false, volume: 0 });
	});
	it('applies reductions before increases when redistributing gain', async () => {
		let calls = 0;
		const app = appWithLevel(() => ++calls <= 5 ? level(-50, -20) : level());
		const run = app.autoSetGains(); await vi.advanceTimersByTimeAsync(8000); await run;
		const writes = app.backend.setGain.mock.calls;
		expect(writes[0][0]).toBe('TIA'); // lower TIA/PGA before raising LNA
		expect(writes.findIndex(([name]) => name === 'LNA')).toBeGreaterThan(writes.findIndex(([name]) => name === 'PGA'));
	});
	it('restores starting gains on missing samples', async () => {
		const app = appWithLevel(() => null);
		const run = app.autoSetGains(); await vi.advanceTimersByTimeAsync(3000); await run;
		expect(app.autoGain.status).toContain('No fresh receiver samples');
		expect(app.backend.setGains).toHaveBeenCalledTimes(2);
	});
	it('cancels on receiver stop and does not write more gains', async () => {
		const app = appWithLevel(() => level(-50, -20));
		const run = app.autoSetGains(); await vi.advanceTimersByTimeAsync(100);
		app.running = false; await vi.advanceTimersByTimeAsync(200); await run;
		expect(app.backend.setGain).not.toHaveBeenCalled();
		expect(app.autoGain.active).toBe(false);
	});
	it('keeps applied gains on cancel', async () => {
		const app = appWithLevel(() => level(-50, -20));
		const run = app.autoSetGains(); await vi.advanceTimersByTimeAsync(600);
		expect(app.backend.setGain).toHaveBeenCalled();
		const count = app.backend.setGain.mock.calls.length;
		app.cancelAutoGain(); await vi.advanceTimersByTimeAsync(300); await run;
		expect(app.backend.setGain.mock.calls).toHaveLength(count);
		expect(app.backend.setGains).toHaveBeenCalledOnce();
		expect(app.autoGain.status).toBe('Adjustment cancelled');
	});
	it('does not overwrite gain settings after connecting a different device', async () => {
		const app = appWithLevel();
		const run = app.autoSetGains(); await vi.advanceTimersByTimeAsync(100);
		app.deviceCapabilities = { deviceType: 'hackrf' }; app.gains = { LNA: 16, VGA: 20 };
		await vi.advanceTimersByTimeAsync(300); await run;
		expect(app.gains).toEqual({ LNA: 16, VGA: 20 });
		expect(app.backend.setGains).toHaveBeenCalledOnce();
	});
});
