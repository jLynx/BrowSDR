import { afterEach, describe, expect, it, vi } from 'vitest';
import { LimeSDRDevice } from '@/devices/limesdr/device';
import { receivePlan } from '@/devices/limesdr/receive-plan';

afterEach(() => vi.restoreAllMocks());

// Independent SPI banks and PLL/NCO readback equations: a successful call alone
// does not prove that the mixer or interface represents the requested RF/rate.
function registerDriver(mask = 1) {
	const driver = new LimeSDRDevice().lime;
	const global = new Map([
		[0x0020, 0xfffd],
		[0x002f, mask],
	]);
	const banks = [new Map(), new Map()];
	vi.spyOn(driver, 'writeLMS7002').mockImplementation(async (address, value) => {
		if (address < 0x0100) global.set(address, value);
		else {
			const mac = global.get(0x0020) & 3;
			for (let bank = 0; bank < 2; bank++) if (mac & (1 << bank)) banks[bank].set(address, value);
		}
		driver.cacheRegister(address, value);
	});
	vi.spyOn(driver, 'writeLMS7002Batch').mockImplementation(async (pairs) => {
		for (const [address, value] of pairs) await driver.writeLMS7002(address, value);
	});
	vi.spyOn(driver, 'readLMS7002').mockImplementation(async (address) => {
		if (address < 0x0100) return global.get(address) ?? 0;
		return banks[(global.get(0x0020) & 3) === 2 ? 1 : 0].get(address) ?? 0;
	});
	vi.spyOn(driver, 'tuneVCO').mockResolvedValue(true);
	vi.spyOn(driver, 'waitForSXLock').mockResolvedValue(true);
	vi.spyOn(driver, 'configureFPGAPLL').mockResolvedValue(undefined);
	vi.spyOn(driver, 'writeFPGA').mockResolvedValue(undefined);
	return { driver, global, banks };
}

function cgenFrequency(global) {
	const fraction = (global.get(0x0088) & 15) * 65536 + global.get(0x0087);
	const divider = ((global.get(0x0089) >> 3) & 255) + 1;
	return (30.72e6 * ((global.get(0x0088) >> 4) + 1 + fraction / 1048576)) / (2 * divider);
}

function loFrequency(bank) {
	const fraction = (bank.get(0x011e) & 15) * 65536 + bank.get(0x011d);
	const divider = 2 ** (((bank.get(0x011f) >> 6) & 7) + 1);
	const multiplier = ((bank.get(0x011c) >> 10) & 1) + 1;
	return (30.72e6 * multiplier * ((bank.get(0x011e) >> 4) + 4 + fraction / 1048576)) / divider;
}

function ncoFrequency(global, bank) {
	return ((bank.get(0x0442) * 65536 + bank.get(0x0443)) / 2 ** 32) * (cgenFrequency(global) / 4);
}

describe('LimeSDR low-frequency reception', () => {
	it.each([2e6, 5e6, 10e6, 20e6, 30.72e6, 61.44e6])('delivers 0.100 MHz at %i samples/s from actual LO/NCO/clock words', async (rate) => {
		const { driver, global, banks } = registerDriver();
		await driver.setSampleRate(rate);
		await driver.setReceiveFrequency(100e3);
		const tsp = cgenFrequency(global) / 4;
		const outputRate = tsp / 2 ** (((banks[0].get(0x0403) >> 12) & 7) + 1);
		const divided = global.get(0x002b) & 1;
		const mclk = divided ? tsp / (2 * ((global.get(0x002c) & 255) + 1)) : tsp;
		expect(Math.abs(outputRate - rate)).toBeLessThan(0.1);
		expect(Math.abs(mclk / 2 - rate)).toBeLessThan(0.1);
		expect(Math.abs(loFrequency(banks[0]) - 30e6)).toBeLessThan(0.1);
		for (const bank of banks) {
			expect(Math.abs(loFrequency(banks[0]) - ncoFrequency(global, bank) - 100e3)).toBeLessThan(0.5);
			expect(bank.get(0x0440)).toBe(0); // frequency mode, NCO0
			expect(bank.get(0x040c) & 0x80).toBe(0); // mixer enabled
			expect((bank.get(0x040c) >> 14) & 3).toBe(1);
			expect(bank.get(0x040c) & 0x2000).toBe(0); // positive LimeSuite RX offset
		}
		expect(driver.currentFrequency).toBe(100e3);
		expect(driver.sxReady).toBe(true);
		expect(driver.configureFPGAPLL).toHaveBeenLastCalledWith();
	});

	it('uses the opposite RX mixer sign on mask revision zero', async () => {
		const { driver, banks } = registerDriver(0);
		await driver.setReceiveFrequency(100e3);
		expect(banks[0].get(0x040c) & 0x2000).toBe(0x2000);
	});

	it('keeps HF mixing through sample-rate changes, RX2 selection, gain changes, and PLL recovery', async () => {
		const { driver, global, banks } = registerDriver();
		await driver.setReceiveFrequency(100e3);
		await driver.setSampleRate(2e6);
		await driver.setRxChannel(1);
		await driver.setTIAGain(1);
		expect(driver.receiveBandwidth).toBe(61.8e6);
		expect(Math.abs(ncoFrequency(global, banks[1]) - 29.9e6)).toBeLessThan(0.5);
		// This capacitor must represent the wide pre-mixer band, not 1 MHz IF.
		expect(banks[1].get(0x0112) & 4095).toBeLessThan(250);
		driver.rxRunning = [];
		const tune = vi.spyOn(driver, 'setFrequencySXR');
		await driver.checkStreamingSXLock();
		expect(tune).toHaveBeenLastCalledWith(30e6, 0);
		expect(driver.currentFrequency).toBe(100e3);
		expect(global.get(0x0020) & 3).toBe(2);
		expect(Math.abs(ncoFrequency(global, banks[1]) - 29.9e6)).toBeLessThan(0.5);
	});

	it('bypasses NCO and restores two-times sampling when returning to VHF', async () => {
		const { driver, global, banks } = registerDriver();
		await driver.setReceiveFrequency(100e3);
		await driver.setReceiveFrequency(100e6);
		for (const bank of banks) {
			expect(bank.get(0x040c) & 0x80).toBe(0x80);
			expect(bank.get(0x0442)).toBe(0);
			expect(bank.get(0x0443)).toBe(0);
			expect((bank.get(0x0403) >> 12) & 7).toBe(0);
		}
		expect(global.get(0x002b) & 1).toBe(0);
		expect(cgenFrequency(global)).toBeCloseTo(80e6, 0);
		expect(driver.currentFrequency).toBe(100e6);
	});

	it('rejects an unsupported HF rate and frequencies before writing USB registers', async () => {
		const { driver } = registerDriver();
		await driver.setSampleRate(1e6);
		driver.writeLMS7002.mockClear();
		await expect(driver.setReceiveFrequency(100e3)).rejects.toThrow('select 2 MS/s or higher');
		for (const frequency of [0, -1, 99999, 3.8e9 + 1, NaN]) {
			await expect(driver.setReceiveFrequency(frequency)).rejects.toThrow('between 0.100 and 3800 MHz');
		}
		expect(driver.writeLMS7002).not.toHaveBeenCalled();
		expect(driver.currentFrequency).toBe(100e6);
		expect(receivePlan(3.8e9, 1e6).offset).toBe(0);
	});

	it('rebuilds prior clocks after a failed HF configuration before accepting another tune', async () => {
		const { driver, global } = registerDriver();
		const cgen = vi.spyOn(driver, 'setCGENFrequency');
		cgen.mockRejectedValueOnce(new Error('CGEN failed'));
		await expect(driver.setReceiveFrequency(100e3)).rejects.toThrow('CGEN failed');
		expect(driver.currentFrequency).toBe(100e6);
		expect(driver.sxReady).toBe(false);
		await driver.setReceiveFrequency(100e6);
		expect(cgen).toHaveBeenLastCalledWith(80e6);
		expect(cgenFrequency(global)).toBeCloseTo(80e6, 0);
		expect(driver.sxReady).toBe(true);
	});
});
