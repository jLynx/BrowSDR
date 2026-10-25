import { afterEach, describe, expect, it, vi } from 'vitest';
import { LimeSDRDevice } from '@/devices/limesdr/device';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// Model the independent hardware comparator, including the SX capacitor-bank
// discontinuity at 128. Register readback alone cannot establish PLL lock.
function comparatorDriver(module, intervals, endpoints = [0, 3]) {
	const driver = new LimeSDRDevice().lime;
	const cswAddress = module === 'SX' ? 0x0121 : 0x008b;
	const cmpAddress = module === 'SX' ? 0x0123 : 0x008c;
	const shift = module === 'SX' ? 3 : 1;
	const registers = new Map();
	vi.spyOn(driver, 'writeLMS7002').mockImplementation(async (address, value) => {
		registers.set(address, value);
		driver.cacheRegister(address, value);
	});
	vi.spyOn(driver, 'readLMS7002').mockImplementation(async (address) => {
		if (address !== cmpAddress) return registers.get(address) ?? 0;
		const csw = ((registers.get(cswAddress) ?? 0) >> shift) & 255;
		if (module === 'SX' && (csw === 0 || csw === 255)) return endpoints[csw === 0 ? 0 : 1] << 12;
		const interval = intervals[module === 'SX' && csw >= 128 ? 1 : 0];
		return (csw < interval[0] ? 0 : csw > interval[1] ? 3 : 2) << 12;
	});
	return { driver, csw: () => ((registers.get(cswAddress) ?? 0) >> shift) & 255 };
}

function bandRestoreDriver({ recover = true, fallback = false, widths = [8, 8] } = {}) {
	const driver = new LimeSDRDevice().lime;
	const registers = new Map([
		[0x0020, 0xfffd],
		[0x0120, 192],
	]);
	let restoring = false;
	let recovered = false;
	let tunes = 0;
	vi.spyOn(driver, 'writeLMS7002').mockImplementation(async (address, value) => {
		registers.set(address, value);
		driver.cacheRegister(address, value);
		if (address === 0x0121) restoring = true;
	});
	vi.spyOn(driver, 'readLMS7002').mockImplementation(async (address) => {
		if (address === 0x0123) return recovered || (fallback && ((registers.get(0x0121) >> 1) & 3) === 1) ? 0x2000 : 0;
		return registers.get(address) ?? 0;
	});
	vi.spyOn(driver, 'tuneVCO').mockImplementation(async () => {
		tunes++;
		const band = ((registers.get(0x0121) ?? 0) >> 1) & 3;
		if (tunes <= 2) {
			const value = ((band === 0 ? 120 : 180) << 3) | (band << 1);
			registers.set(0x0121, value);
			driver.cacheRegister(0x0121, value);
			driver.sxLockWidth = widths[band] ?? 0;
			return band !== 2;
		}
		if (restoring && band === 0 && recover) {
			const value = 124 << 3;
			registers.set(0x0121, value);
			driver.cacheRegister(0x0121, value);
			recovered = true;
			return true;
		}
		return false;
	});
	return { driver, registers };
}

function lockedRegisterDriver() {
	const driver = new LimeSDRDevice().lime;
	const registers = new Map([
		[0x0020, 0xfffd],
		[0x0089, 0x1000],
		[0x011c, 0x8941],
	]);
	vi.spyOn(driver, 'writeLMS7002').mockImplementation(async (address, value) => {
		registers.set(address, value);
		driver.cacheRegister(address, value);
	});
	vi.spyOn(driver, 'writeLMS7002Batch').mockImplementation(async (pairs) => {
		for (const [address, value] of pairs) await driver.writeLMS7002(address, value);
	});
	vi.spyOn(driver, 'readLMS7002').mockImplementation(async (address) => registers.get(address) ?? 0);
	vi.spyOn(driver, 'tuneVCO').mockResolvedValue(true);
	vi.spyOn(driver, 'waitForSXLock').mockResolvedValue(true);
	return { driver, registers };
}

// Decode the hardware words using the LMS7002M frequency equations, independently
// of the driver's tuning calculation and its currentFrequency bookkeeping.
function sxFrequency(registers) {
	const word = registers.get(0x011e);
	const fraction = (word & 15) * 65536 + registers.get(0x011d);
	const divider = 2 ** (((registers.get(0x011f) >> 6) & 7) + 1);
	const multiplier = ((registers.get(0x011c) >> 10) & 1) + 1;
	return (30.72e6 * multiplier * ((word >> 4) + 4 + fraction / 1048576)) / divider;
}

describe('LimeSDR frequency programming', () => {
	it.each([43.9e6, 44.2e6, 48.5e6, 128.305e6, 3.8e9])('programs the requested RF frequency %i Hz', async (frequency) => {
		const { driver, registers } = lockedRegisterDriver();
		await driver.setFrequencySXR(frequency);
		expect(sxFrequency(registers) / 1e6).toBeCloseTo(frequency / 1e6, 4);
		expect(driver.currentFrequency).toBe(frequency);
		expect(driver.sxReady).toBe(true);
	});

	it('carries SX fractional rounding into INT at a reference-clock boundary', async () => {
		const { driver, registers } = lockedRegisterDriver();
		await driver.setFrequencySXR(169.9199999e6);
		expect(registers.get(0x011e) >> 4).toBe(173);
		expect(registers.get(0x011e) & 15).toBe(0);
		expect(registers.get(0x011d)).toBe(0);
		expect(sxFrequency(registers)).toBeCloseTo(169.92e6, 0);
	});

	it('carries CGEN fractional rounding into INT rather than changing the sample clock', async () => {
		const { driver, registers } = lockedRegisterDriver();
		await driver.setCGENFrequency(153.6e6 - 0.01);
		const word = registers.get(0x0088);
		const fraction = (word & 15) * 65536 + registers.get(0x0087);
		const divider = ((registers.get(0x0089) >> 3) & 255) + 1;
		const clock = (30.72e6 * ((word >> 4) + 1 + fraction / 1048576)) / (2 * divider);
		expect(word >> 4).toBe(79);
		expect(fraction).toBe(0);
		expect(clock).toBeCloseTo(153.6e6, 0);
	});

	it.each([
		[0x011e, 0x0010],
		[0x011d, 0x0002],
		[0x011f, 0x0040],
		[0x011c, 0x0400],
	])('rejects a locked synthesizer with incorrect readback at register 0x%s', async (address, mask) => {
		const { driver, registers } = lockedRegisterDriver();
		driver.rxChannel = 1;
		driver.readLMS7002.mockImplementation(async (register) => {
			const value = registers.get(register) ?? 0;
			return register === address ? value ^ mask : value;
		});
		await expect(driver.setFrequencySXR(44.2e6)).rejects.toThrow('SXR frequency readback mismatch');
		expect(driver.currentFrequency).toBe(100e6);
		expect(driver.sxReady).toBe(false);
		expect(registers.get(0x0020) & 3).toBe(2);
	});
});

describe('LimeSDR PLL lock', () => {
	it.each([
		['CGEN', [[40, 60]], 50],
		[
			'SX',
			[
				[40, 60],
				[300, 310],
			],
			50,
		],
		[
			'SX',
			[
				[-10, -1],
				[170, 200],
			],
			185,
		],
		[
			'SX',
			[
				[100, 127],
				[128, 160],
			],
			130,
		],
		[
			'SX',
			[
				[40, 45],
				[170, 200],
			],
			185,
		],
		[
			'SX',
			[
				[63, 63],
				[300, 310],
			],
			63,
		],
	])('centers %s within the usable lock range %j', async (module, intervals, expected) => {
		vi.useFakeTimers();
		const { driver, csw } = comparatorDriver(module, intervals);
		const tuning = driver.tuneVCO(module);
		await vi.runAllTimersAsync();
		expect(await tuning).toBe(true);
		expect(csw()).toBe(expected);
		if (module === 'SX') expect(driver.sxLockWidth).toBeGreaterThan(0);
	});

	it('rejects a VCO with no lock range', async () => {
		vi.useFakeTimers();
		const { driver } = comparatorDriver('SX', [
			[300, 310],
			[300, 310],
		]);
		const tuning = driver.tuneVCO('SX');
		await vi.runAllTimersAsync();
		expect(await tuning).toBe(false);
	});

	it.each([
		[3, 3],
		[0, 0],
	])('rejects misleading interior locks when SX endpoints are %j', async (...endpoints) => {
		vi.useFakeTimers();
		const { driver } = comparatorDriver(
			'SX',
			[
				[40, 60],
				[170, 200],
			],
			endpoints,
		);
		const tuning = driver.tuneVCO('SX');
		await vi.runAllTimersAsync();
		expect(await tuning).toBe(false);
		expect(driver.sxLockWidth).toBe(0);
	});

	it('keeps the low VCO for 131 → 150 → 150 → 250 MHz despite a wider false lock in VCOM', async () => {
		vi.useFakeTimers();
		const { driver, registers } = bandRestoreDriver({ recover: false, widths: [7, 16] });
		driver.readLMS7002.mockImplementation(async (address) => {
			if (address === 0x0123) return 0x2000;
			return registers.get(address) ?? 0;
		});
		driver.tuneVCO.mockImplementation(async () => {
			const band = (registers.get(0x0121) >> 1) & 3;
			const value = ((band === 0 ? 44 : 39) << 3) | (band << 1);
			registers.set(0x0121, value);
			driver.cacheRegister(0x0121, value);
			driver.sxLockWidth = band === 0 ? 7 : 16;
			return band !== 2;
		});
		for (const frequency of [131e6, 150e6, 150e6, 250e6]) {
			const tuning = driver.setFrequencySXR(frequency);
			await vi.runAllTimersAsync();
			await tuning;
			expect(driver.currentFrequency).toBe(frequency);
			expect((registers.get(0x0121) >> 1) & 3).toBe(0);
		}
	});

	it('retunes a selected band that loses lock after searching other bands', async () => {
		vi.useFakeTimers();
		const { driver, registers } = bandRestoreDriver();
		const tuning = driver.setFrequencySXR(160e6);
		await vi.runAllTimersAsync();
		await tuning;
		expect(driver.currentFrequency).toBe(160e6);
		expect(driver.tuneVCO).toHaveBeenCalledTimes(3);
		expect((registers.get(0x0121) >> 3) & 255).toBe(124);
		expect(registers.get(0x0120)).toBe(192);
	});

	it('uses another candidate when the preferred band cannot hold lock', async () => {
		vi.useFakeTimers();
		const { driver, registers } = bandRestoreDriver({ recover: false, fallback: true });
		const tuning = driver.setFrequencySXR(160e6);
		await vi.runAllTimersAsync();
		await tuning;
		expect(driver.currentFrequency).toBe(160e6);
		expect((registers.get(0x0121) >> 1) & 3).toBe(1);
		expect(registers.get(0x0120)).toBe(192);
	});

	it('prefers a wider lock interval even when its capacitor setting is farther from 128', async () => {
		vi.useFakeTimers();
		const { driver, registers } = bandRestoreDriver({ recover: false, fallback: true, widths: [1, 8] });
		const tuning = driver.setFrequencySXR(160e6);
		await vi.runAllTimersAsync();
		await tuning;
		expect((registers.get(0x0121) >> 1) & 3).toBe(1);
		expect(driver.tuneVCO).toHaveBeenCalledTimes(2);
		expect(registers.get(0x0120)).toBe(192);
	});

	it('waits through transient comparator readings and requires sustained lock', async () => {
		vi.useFakeTimers();
		const driver = new LimeSDRDevice().lime;
		const readings = [0, 2, 0, 2, 2, 2, ...Array(20).fill(2)];
		const read = vi.spyOn(driver, 'readLMS7002').mockImplementation(async () => readings.shift() << 12);
		const locking = driver.waitForSXLock();
		await vi.runAllTimersAsync();
		expect(await locking).toBe(true);
		expect(read).toHaveBeenCalledTimes(26);
	});

	it('rejects intermittent loss of lock hundreds of milliseconds after the initial confirmation', async () => {
		vi.useFakeTimers();
		const driver = new LimeSDRDevice().lime;
		const readings = [...Array(18).fill(2), 0];
		vi.spyOn(driver, 'readLMS7002').mockImplementation(async () => readings.shift() << 12);
		let settled = false;
		const locking = driver.waitForSXLock().then((locked) => {
			settled = true;
			return locked;
		});
		await vi.advanceTimersByTimeAsync(700);
		expect(settled).toBe(false);
		await vi.runAllTimersAsync();
		expect(await locking).toBe(false);
	});

	it('prefers another valid oscillator when recovering the band that lost lock during reception', async () => {
		vi.useFakeTimers();
		const { driver, registers } = bandRestoreDriver({ recover: false, widths: [8, 16] });
		driver.readLMS7002.mockImplementation(async (address) => (address === 0x0123 ? 0x2000 : (registers.get(address) ?? 0)));
		const tuning = driver.setFrequencySXR(160e6, 1);
		await vi.runAllTimersAsync();
		await tuning;
		expect((registers.get(0x0121) >> 1) & 3).toBe(0);
		expect(driver.sxReady).toBe(true);
	});

	it.each([true, false])('recovers late streaming loss of lock in bank A and restores RX2 (recovery=%s)', async (recovery) => {
		const driver = new LimeSDRDevice().lime;
		driver.rxChannel = 1;
		driver.currentFrequency = 160e6;
		driver.rxRunning = [];
		driver.sxReady = true;
		const modify = vi.spyOn(driver, 'modifyReg').mockResolvedValue(undefined);
		vi.spyOn(driver, 'readLMS7002').mockImplementation(async (address) => (address === 0x0121 ? (55 << 3) | 2 : 0));
		const tune = vi.spyOn(driver, 'setFrequencySXR');
		if (recovery) tune.mockResolvedValue(undefined);
		else tune.mockRejectedValue(new Error('No stable band'));
		const checking = driver.checkStreamingSXLock();
		if (recovery) await checking;
		else await expect(checking).rejects.toThrow('No stable band');
		expect(tune).toHaveBeenCalledWith(160e6, 1);
		expect(modify).toHaveBeenLastCalledWith(0x0020, 1, 0, 2);
	});

	it('does not retune a stable streaming PLL or read a stopped receiver', async () => {
		const driver = new LimeSDRDevice().lime;
		driver.sxReady = true;
		const modify = vi.spyOn(driver, 'modifyReg').mockResolvedValue(undefined);
		vi.spyOn(driver, 'readLMS7002').mockResolvedValue(0x2000);
		const tune = vi.spyOn(driver, 'setFrequencySXR');
		await driver.checkStreamingSXLock();
		expect(modify).not.toHaveBeenCalled();
		driver.rxRunning = [];
		await driver.checkStreamingSXLock();
		expect(tune).not.toHaveBeenCalled();
	});

	it('rejects a lock indication that drifts away after startup settling', async () => {
		vi.useFakeTimers();
		const driver = new LimeSDRDevice().lime;
		const readings = [2, 2, 2, 2, 2, 0];
		vi.spyOn(driver, 'readLMS7002').mockImplementation(async () => readings.shift() << 12);
		const locking = driver.waitForSXLock();
		await vi.runAllTimersAsync();
		expect(await locking).toBe(false);
	});

	it.each([false, true])('verifies SXR in bank A after RX starts and restores RX2 (lostLock=%s)', async (lostLock) => {
		const driver = new LimeSDRDevice().lime;
		driver.rxChannel = 1;
		driver.currentFrequency = 160e6;
		const modify = vi.spyOn(driver, 'modifyReg').mockResolvedValue(undefined);
		vi.spyOn(driver, 'waitForSXLock').mockResolvedValue(!lostLock);
		const tune = vi.spyOn(driver, 'setFrequencySXR').mockResolvedValue(undefined);
		await driver.verifyStreamingSXLock();
		expect(modify.mock.calls).toEqual([
			[0x0020, 1, 0, 1],
			[0x0020, 1, 0, 2],
		]);
		expect(tune).toHaveBeenCalledTimes(lostLock ? 1 : 0);
		if (lostLock) expect(tune).toHaveBeenCalledWith(160e6);
	});

	it('propagates post-start retuning failure and restores the receive bank', async () => {
		const driver = new LimeSDRDevice().lime;
		driver.rxChannel = 1;
		const modify = vi.spyOn(driver, 'modifyReg').mockResolvedValue(undefined);
		vi.spyOn(driver, 'waitForSXLock').mockResolvedValue(false);
		vi.spyOn(driver, 'setFrequencySXR').mockRejectedValue(new Error('SX VCO failed to lock'));
		await expect(driver.verifyStreamingSXLock()).rejects.toThrow('SX VCO failed to lock');
		expect(modify).toHaveBeenLastCalledWith(0x0020, 1, 0, 2);
	});

	it('rejects a comparator that never sustains lock', async () => {
		vi.useFakeTimers();
		const driver = new LimeSDRDevice().lime;
		const readings = [2, 2, 0, 2, 2, 0, 2, 2, 0, 2];
		vi.spyOn(driver, 'readLMS7002').mockImplementation(async () => readings.shift() << 12);
		const locking = driver.waitForSXLock();
		await vi.runAllTimersAsync();
		expect(await locking).toBe(false);
	});

	it('retries with increasing bias when the initial bands cannot lock', async () => {
		vi.useFakeTimers();
		const { driver, registers } = bandRestoreDriver({ recover: false });
		registers.set(0x0120, 0);
		driver.tuneVCO.mockImplementation(async () => registers.get(0x0120) >= 96);
		driver.readLMS7002.mockImplementation(async (address) => {
			if (address === 0x0123) return registers.get(0x0120) >= 96 ? 0x2000 : 0;
			return registers.get(address) ?? 0;
		});
		const tuning = driver.setFrequencySXR(160e6);
		await vi.runAllTimersAsync();
		await tuning;
		expect(driver.currentFrequency).toBe(160e6);
		expect(registers.get(0x0120)).toBe(96);
		expect(driver.tuneVCO).toHaveBeenCalledTimes(8);
	});

	it('stops recovery at maximum bias and retains the last confirmed frequency', async () => {
		vi.useFakeTimers();
		const { driver, registers } = bandRestoreDriver({ recover: false });
		driver.currentFrequency = 157.95e6;
		const tuning = expect(driver.setFrequencySXR(160e6)).rejects.toThrow('SX VCO lost lock');
		await vi.runAllTimersAsync();
		await tuning;
		expect(driver.currentFrequency).toBe(157.95e6);
		expect(driver.sxReady).toBe(false);
		expect(registers.get(0x0120)).toBe(255);
		expect(driver.tuneVCO).toHaveBeenCalledTimes(8);
		expect(registers.get(0x0020) & 3).toBe(1);
	});

	it('rejects lock lost when restoring the selected band and retains the last confirmed frequency', async () => {
		vi.useFakeTimers();
		const driver = new LimeSDRDevice().lime;
		driver.currentFrequency = 157.95e6;
		vi.spyOn(driver, 'modifyReg').mockResolvedValue(undefined);
		vi.spyOn(driver, 'writeLMS7002').mockResolvedValue(undefined);
		vi.spyOn(driver, 'readLMS7002').mockResolvedValue(0);
		vi.spyOn(driver, 'tuneVCO').mockResolvedValue(true);
		const tuning = expect(driver.setFrequencySXR(159e6)).rejects.toThrow('SX VCO lost lock');
		await vi.runAllTimersAsync();
		await tuning;
		expect(driver.currentFrequency).toBe(157.95e6);
		expect(driver.modifyReg).toHaveBeenLastCalledWith(0x0020, 1, 0, 1);
	});

	it('initializes SX voltage, bias and charge-pump/filter settings before tuning', async () => {
		vi.useFakeTimers();
		const driver = new LimeSDRDevice().lime;
		vi.spyOn(driver, 'sendCommand').mockResolvedValue(new Uint8Array(64));
		vi.spyOn(driver, 'writeLMS7002').mockResolvedValue(undefined);
		vi.spyOn(driver, 'modifyReg').mockResolvedValue(undefined);
		const batch = vi.spyOn(driver, 'writeLMS7002Batch').mockResolvedValue(undefined);
		for (const method of [
			'setCGENFrequency',
			'setAnalogBandwidth',
			'setAntennaPath',
			'setLNAGain',
			'setTIAGain',
			'setPGAGain',
			'configureRxTSP',
			'configureLML',
			'configureFPGA',
			'dumpRegisters',
		])
			vi.spyOn(driver, method).mockResolvedValue(undefined);
		vi.spyOn(driver, 'setFrequencySXR').mockImplementation(async () => {
			const initial = new Map(batch.mock.calls.flatMap(([pairs]) => pairs));
			// Values from LimeSuite LMS7_Device::Init, not silicon reset defaults.
			expect(initial.get(0x011c)).toBe(0x8941);
			expect(initial.get(0x0120)).toBe(0xe6c0);
			expect(initial.get(0x0121)).toBe(0x3638);
			expect(initial.get(0x0122)).toBe(0x0514);
			expect(initial.get(0x0123)).toBe(0x200f);
			// MAC=3 broadcasts initialization to both banks before SXR selects A.
			expect(driver.writeLMS7002).toHaveBeenCalledWith(0x0020, 0xffff);
		});
		const initialization = driver.initialize();
		await vi.runAllTimersAsync();
		await initialization;
		expect(driver.setFrequencySXR).toHaveBeenCalledOnce();
	});
});
