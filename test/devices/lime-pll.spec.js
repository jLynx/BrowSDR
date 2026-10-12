import { afterEach, describe, expect, it, vi } from 'vitest';
import { LimeSDRDevice } from '@/devices/limesdr/device';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// Model the independent hardware comparator, including the SX capacitor-bank
// discontinuity at 128. Register readback alone cannot establish PLL lock.
function comparatorDriver(module, intervals) {
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
		const interval = intervals[module === 'SX' && csw >= 128 ? 1 : 0];
		return (csw < interval[0] ? 0 : csw > interval[1] ? 3 : 2) << 12;
	});
	return { driver, csw: () => ((registers.get(cswAddress) ?? 0) >> shift) & 255 };
}

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
