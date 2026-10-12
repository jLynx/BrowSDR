import { afterEach, describe, expect, it, vi } from 'vitest';
import { reactive, nextTick } from 'vue';
import { HackRFDevice } from '@/devices/hackrf/device';
import { HackRFRxLevel } from '@/devices/hackrf/rx-level';
import { hackrfGainProfile, hackrfGainTotal, nextHackRFGain, createHackRFGainAdjustment } from '@/radio/hackrf-auto-gain';
import { autoGainMethods } from '@/app/radio/auto-gain';

afterEach(() => vi.useRealTimers());
const level = (rmsDbfs = -22, peakDbfs = -8, clippedFraction = 0) => ({
	started: Date.now() - 250,
	timestamp: Date.now(),
	samples: 800,
	rmsDbfs,
	peakDbfs,
	clippedFraction,
});

describe('HackRF ADC level measurements', () => {
	it('interprets USB bytes as signed IQ and respects view offsets without changing data', () => {
		const buffer = new Uint8Array(4104).fill(127);
		const data = buffer.subarray(4, 4100);
		data.fill(192); // -64 as a signed byte
		const original = buffer.slice();
		const meter = new HackRFRxLevel();
		meter.reset(1000);
		meter.observe(data, 1250);
		expect(meter.level.rmsDbfs).toBeCloseTo(-6.0206);
		expect(meter.level.peakDbfs).toBeCloseTo(-6.0206);
		expect(meter.level.clippedFraction).toBe(0);
		expect(meter.level.samples).toBeLessThanOrEqual(2048);
		expect(buffer).toEqual(original);
	});
	it('detects both ADC rails, reports silent samples and clears stale measurements', () => {
		const meter = new HackRFRxLevel();
		meter.reset(1000);
		meter.observe(
			new Int8Array(4096).map((_, index) => (index % 2 ? -128 : 127)),
			1250,
		);
		expect(meter.level.clippedFraction).toBe(1);
		meter.observe(new Int8Array(4096), 1500);
		expect(meter.level.rmsDbfs).toBe(-120);
		meter.reset(1501);
		expect(meter.level).toBeNull();
	});
	it('measures through the actual HackRF USB receive callback and preserves delivered IQ', async () => {
		vi.useFakeTimers();
		const device = new HackRFDevice();
		const transfers = [];
		device.hackrf.device = {
			controlTransferOut: vi.fn(async () => ({ status: 'ok' })),
			transferIn: vi.fn(() => new Promise((resolve) => transfers.push(resolve))),
		};
		const callback = vi.fn();
		const starting = device.startRx(callback);
		await vi.advanceTimersByTimeAsync(300);
		const samples = new Int8Array(4096).fill(-16);
		transfers.shift()({ status: 'ok', data: new DataView(samples.buffer) });
		await vi.advanceTimersByTimeAsync(1);
		await starting;
		expect(callback).toHaveBeenCalledOnce();
		expect(Array.from(new Int8Array(callback.mock.calls[0][0].buffer))).toEqual(Array.from(samples));
		expect(device.getRxLevel().rmsDbfs).toBeCloseTo(-18.0618);
		const stopping = device.stopRx();
		await vi.advanceTimersByTimeAsync(1);
		for (const resolve of transfers) resolve({ status: 'ok', data: new DataView(samples.buffer) });
		await stopping;
		expect(device.getRxLevel()).toBeNull();
	});
});

describe('HackRF gain staging', () => {
	it('balances IF and baseband within hardware limits and discrete steps', () => {
		for (let total = 0; total <= 102; total += 2) {
			const gains = hackrfGainProfile(total);
			expect(hackrfGainTotal(gains)).toBe(total);
			expect(gains.LNA % 8).toBe(0);
			expect(gains.VGA % 2).toBe(0);
			expect(gains.LNA).toBeGreaterThanOrEqual(0);
			expect(gains.LNA).toBeLessThanOrEqual(40);
			expect(gains.VGA).toBeGreaterThanOrEqual(0);
			expect(gains.VGA).toBeLessThanOrEqual(62);
			if (total <= 80) expect(Math.abs(gains.LNA - gains.VGA)).toBeLessThanOrEqual(8);
		}
		expect(hackrfGainProfile(32)).toEqual({ LNA: 16, VGA: 16 });
		expect(hackrfGainTotal(hackrfGainProfile(-20))).toBe(0);
		expect(hackrfGainTotal(hackrfGainProfile(150))).toBe(102);
	});
	it('reduces overload faster than it raises weak gain, and respects peak headroom', () => {
		const gains = { LNA: 16, VGA: 16 };
		expect(hackrfGainTotal(nextHackRFGain(gains, level(-12, -0.1, 0.01)).gains)).toBe(26);
		expect(hackrfGainTotal(nextHackRFGain(gains, level(-45, -20)).gains)).toBe(34);
		expect(nextHackRFGain(gains, level()).done).toBe(true);
		expect(nextHackRFGain(gains, level(-40, -5)).done).toBe(true);
		expect(nextHackRFGain({ LNA: 40, VGA: 62, 'Amp (14dB)': 1 }, level(-45, -20)).reason).toBe('Gain limit reached');
		expect(() => nextHackRFGain(gains, level(-120, -120))).toThrow('samples are silent');
	});
	it('uses downstream gain first, stages amplifier activation, and disables it on clipping', () => {
		const moderate = nextHackRFGain({ LNA: 16, VGA: 16, 'Amp (14dB)': 0 }, level(-45, -20));
		expect(moderate.gains['Amp (14dB)']).toBe(0);
		const weak = nextHackRFGain({ LNA: 32, VGA: 40, 'Amp (14dB)': 0 }, level(-45, -20));
		expect(weak.gains['Amp (14dB)']).toBe(1);
		expect(weak.gains.LNA + weak.gains.VGA).toBeLessThan(72);
		expect(weak.reason).toContain('Enabling RF amplifier');
		const strong = nextHackRFGain(weak.gains, level(-12, -0.1, 0.01));
		expect(strong.gains['Amp (14dB)']).toBe(0);
		expect(strong.reason).toContain('Disabling RF amplifier');
		expect(hackrfGainTotal(strong.gains)).toBeLessThan(hackrfGainTotal(weak.gains));
	});
});

function appWithLevel(readLevel = () => level(), amp = 0) {
	vi.useFakeTimers();
	return reactive({
		...autoGainMethods,
		autoGain: { active: false, status: '', level: null },
		gains: { LNA: 16, VGA: 16, 'Amp (14dB)': amp },
		radio: { centerFreq: 100, sampleRate: 20000000, frequencyShift: 0 },
		vfos: [{ enabled: false, volume: 0 }],
		running: true,
		connected: true,
		remoteMode: 'none',
		deviceCapabilities: { deviceType: 'hackrf' },
		saveSetting: vi.fn(),
		$nextTick: nextTick,
		backend: {
			setGains: vi.fn().mockResolvedValue(undefined),
			setGain: vi.fn().mockResolvedValue(undefined),
			getRxLevel: vi.fn(readLevel),
		},
	});
}

describe('HackRF one-shot automatic gain lifecycle', () => {
	it.each([0, 1])('adjusts HackRF controls with RF amp initially %i and preserves muted audio', async (amp) => {
		const app = appWithLevel(() => level(-45, -20), amp);
		const run = app.autoSetGains();
		await vi.advanceTimersByTimeAsync(600);
		app.cancelAutoGain();
		await vi.advanceTimersByTimeAsync(300);
		await run;
		expect(app.backend.setGains).toHaveBeenCalledWith({ LNA: 16, VGA: 16, 'Amp (14dB)': amp });
		expect(app.backend.setGain).toHaveBeenCalled();
		for (const [name, value] of app.backend.setGain.mock.calls) {
			expect(['LNA', 'VGA', 'Amp (14dB)']).toContain(name);
			if (name === 'Amp (14dB)') expect([0, 1]).toContain(value);
			else expect(value % (name === 'LNA' ? 8 : 2)).toBe(0);
		}
		expect(app.gains['Amp (14dB)']).toBe(amp);
		expect(app.vfos[0]).toMatchObject({ enabled: false, volume: 0 });
	});
	it('reduces downstream gain before enabling the RF amplifier', async () => {
		const app = appWithLevel(() => level(-45, -20));
		app.gains.LNA = 32;
		app.gains.VGA = 40;
		const run = app.autoSetGains();
		await vi.advanceTimersByTimeAsync(600);
		app.cancelAutoGain();
		await vi.advanceTimersByTimeAsync(300);
		await run;
		const writes = app.backend.setGain.mock.calls;
		expect(writes.at(-1)).toEqual(['Amp (14dB)', 1]);
		expect(writes.slice(0, -1)).toEqual([
			['LNA', 0],
			['VGA', 0],
		]);
		expect(app.gains['Amp (14dB)']).toBe(1);
	});
	it('turns the RF amplifier off before increasing downstream gain after overload', async () => {
		const app = appWithLevel(() => level(-12, -0.1, 0.01), 1);
		const run = app.autoSetGains();
		await vi.advanceTimersByTimeAsync(600);
		app.cancelAutoGain();
		await vi.advanceTimersByTimeAsync(300);
		await run;
		expect(app.backend.setGain.mock.calls.slice(0, 2)).toEqual([
			['LNA', 0],
			['VGA', 0],
		]);
		expect(app.backend.setGain.mock.calls[2]).toEqual(['Amp (14dB)', 0]);
		expect(app.gains['Amp (14dB)']).toBe(0);
	});
	it('restores the original amplifier setting if a later gain write fails', async () => {
		const app = appWithLevel(() => level(-12, -0.1, 0.01), 1);
		app.backend.setGain.mockResolvedValueOnce(undefined).mockRejectedValueOnce('failed to setVgaGain');
		const run = app.autoSetGains();
		await vi.advanceTimersByTimeAsync(1000);
		await run;
		expect(app.backend.setGains.mock.calls.at(-1)[0]).toEqual({ LNA: 16, VGA: 16, 'Amp (14dB)': 1 });
		expect(app.gains['Amp (14dB)']).toBe(1);
	});
	it('reduces VGA before increasing LNA when rebalancing a lopsided setting', async () => {
		const app = appWithLevel(() => level(-45, -20));
		app.gains.LNA = 0;
		app.gains.VGA = 32;
		const run = app.autoSetGains();
		await vi.advanceTimersByTimeAsync(600);
		app.cancelAutoGain();
		await vi.advanceTimersByTimeAsync(300);
		await run;
		expect(app.backend.setGain.mock.calls.slice(0, 2)).toEqual([
			['VGA', 18],
			['LNA', 16],
		]);
	});
	it('reports string errors from the HackRF driver and restores starting gains', async () => {
		const app = appWithLevel(() => level(-45, -20));
		app.backend.setGain.mockRejectedValueOnce('failed to setVgaGain');
		const run = app.autoSetGains();
		await vi.advanceTimersByTimeAsync(1000);
		await run;
		expect(app.autoGain.status).toBe('failed to setVgaGain');
		expect(app.backend.setGains).toHaveBeenCalledTimes(2);
		expect(app.gains).toEqual({ LNA: 16, VGA: 16, 'Amp (14dB)': 0 });
	});
	it('holds settled gains and offers no adjustment for unsupported or remote devices', async () => {
		const app = appWithLevel();
		const run = app.autoSetGains();
		await vi.advanceTimersByTimeAsync(3000);
		await run;
		expect(app.autoGain.status).toBe('Levels settled');
		expect(app.backend.setGain).not.toHaveBeenCalled();
		app.deviceCapabilities.deviceType = 'rtlsdr';
		expect(app.autoGainSupported()).toBe(false);
		await app.autoSetGains();
		expect(app.backend.setGains).toHaveBeenCalledOnce();
		app.deviceCapabilities.deviceType = 'hackrf';
		app.remoteMode = 'client';
		await app.autoSetGains();
		expect(app.backend.setGains).toHaveBeenCalledOnce();
	});
});

describe('HackRF gain preferences', () => {
	it('redistributes settled levels for sensitivity and strong signals', () => {
		const starting = { LNA: 16, VGA: 16, 'Amp (14dB)': 0 };
		const weak = nextHackRFGain(starting, level(-20, -8), 'sensitivity');
		expect(weak.gains['Amp (14dB)']).toBe(1);
		expect(weak.gains.LNA).toBe(0);
		expect(weak.gains).toEqual({ LNA: 0, VGA: 0, 'Amp (14dB)': 1 });
		expect(weak.done).toBe(false);
		const strong = nextHackRFGain(weak.gains, level(-28, -14), 'strong');
		expect(strong.gains['Amp (14dB)']).toBe(0);
		expect(strong.gains.LNA).toBeLessThan(strong.gains.VGA);
		expect(hackrfGainTotal(strong.gains)).toBe(10);
	});
	it('retains clipping protection in sensitivity mode and can inhibit amp retries', () => {
		const starting = { LNA: 32, VGA: 40, 'Amp (14dB)': 1 };
		const overloaded = nextHackRFGain(starting, level(-12, -1, 0.01), 'sensitivity');
		expect(overloaded.gains['Amp (14dB)']).toBe(0);
		expect(hackrfGainTotal(overloaded.gains)).toBeLessThan(hackrfGainTotal(starting));
		expect(nextHackRFGain(overloaded.gains, level(-40, -20), 'sensitivity', false).gains['Amp (14dB)']).toBe(0);
	});
});

describe('bounded HackRF amplifier trials', () => {
	it('tries the amp after reducing overload with the amp off', () => {
		const adjust = createHackRFGainAdjustment('sensitivity');
		const reduced = adjust({ LNA: 32, VGA: 26, 'Amp (14dB)': 0 }, level(-12, -1, 0.01));
		expect(reduced.gains['Amp (14dB)']).toBe(0);
		expect(hackrfGainTotal(reduced.gains)).toBe(52);
		const trial = adjust(reduced.gains, level(-25, -9));
		expect(trial.gains['Amp (14dB)']).toBe(1);
		expect(trial.gains.LNA + trial.gains.VGA).toBeLessThan(reduced.gains.LNA + reduced.gains.VGA);
	});
	it('retries once at reduced gain and holds the amp off after a second failure', () => {
		const adjust = createHackRFGainAdjustment('sensitivity');
		expect(adjust({ LNA: 32, VGA: 26, 'Amp (14dB)': 0 }, level(-25, -9)).gains).toEqual({ LNA: 0, VGA: 0, 'Amp (14dB)': 1 });
		const raised = { LNA: 24, VGA: 4, 'Amp (14dB)': 1 };
		const reduced = adjust(raised, level(-12, -1, 0.01));
		expect(reduced.gains['Amp (14dB)']).toBe(0);
		expect(hackrfGainTotal(reduced.gains)).toBe(hackrfGainTotal(raised) - 6);
		const retry = adjust(reduced.gains, level(-40, -20));
		expect(retry.gains['Amp (14dB)']).toBe(1);
		const failed = adjust(retry.gains, level(-12, -1, 0.01));
		let settled = adjust(failed.gains, level(-20, -8));
		for (let step = 0; step < 5; step++) {
			expect(settled.gains['Amp (14dB)']).toBe(0);
			settled = adjust(settled.gains, level(-20, -8));
		}
		expect(settled.done).toBe(true);
		expect(settled.reason).toContain('Amp kept off after repeated overload');
	});
	it('keeps a successful retry enabled and starts each run with a fresh trial budget', () => {
		const adjust = createHackRFGainAdjustment('sensitivity');
		const reduced = adjust({ LNA: 32, VGA: 26, 'Amp (14dB)': 1 }, level(-12, -1, 0.01));
		const retry = adjust(reduced.gains, level(-20, -8));
		expect(retry.gains['Amp (14dB)']).toBe(1);
		expect(adjust(retry.gains, level(-20, -8)).gains['Amp (14dB)']).toBe(1);
		expect(createHackRFGainAdjustment('sensitivity')(reduced.gains, level(-20, -8)).gains['Amp (14dB)']).toBe(1);
		expect(createHackRFGainAdjustment('strong')(retry.gains, level(-28, -14)).gains['Amp (14dB)']).toBe(0);
	});
});

it('uses the bounded amp retry policy through the one-shot receiver lifecycle', async () => {
	const app = appWithLevel();
	app.backend.getRxLevel.mockImplementation(() => {
		const writes = app.backend.setGain.mock.calls;
		const ampWrites = writes.filter(([name]) => name === 'Amp (14dB)');
		const overload = writes.length === 0 || [1, 3].includes(ampWrites.length);
		return { ...level(overload ? -12 : -20, overload ? -1 : -8, overload ? 0.01 : 0), started: Date.now() };
	});
	const run = app.autoSetGains('sensitivity');
	await vi.advanceTimersByTimeAsync(10000);
	await run;
	expect(app.backend.setGain.mock.calls.filter(([name]) => name === 'Amp (14dB)').map(([, value]) => value)).toEqual([1, 0, 1, 0]);
	expect(app.gains['Amp (14dB)']).toBe(0);
	expect(app.autoGain.status).toContain('Amp kept off after repeated overload');
});

it('raises gain gradually from minimum after enabling the amp, using fresh measurements', () => {
	const adjust = createHackRFGainAdjustment('sensitivity');
	let current = adjust({ LNA: 32, VGA: 26, 'Amp (14dB)': 0 }, level(-25, -9)).gains;
	expect(current).toEqual({ LNA: 0, VGA: 0, 'Amp (14dB)': 1 });
	for (let step = 0; step < 10; step++) {
		const next = adjust(current, level(-45, -20));
		expect(next.gains['Amp (14dB)']).toBe(1);
		expect(hackrfGainTotal(next.gains) - hackrfGainTotal(current)).toBe(2);
		current = next.gains;
	}
});
