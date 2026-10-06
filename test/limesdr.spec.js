import { afterEach, describe, expect, it, vi } from 'vitest';
import { LimeSDRDevice } from '../src/client/devices/limesdr';

async function createDriver() {
	const packets = [];
	const usb = {
		open: vi.fn().mockResolvedValue(undefined),
		selectConfiguration: vi.fn().mockResolvedValue(undefined),
		claimInterface: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		transferOut: vi.fn(async (endpoint, packet) => {
			packets.push(packet.slice());
			return { status: 'ok', bytesWritten: packet.length };
		}),
		transferIn: vi.fn(async () => {
			const response = packets[packets.length - 1].slice();
			response[1] = 1;
			response[10] = 0x12;
			response[11] = 0x34;
			return { status: 'ok', data: new DataView(response.buffer) };
		}),
	};
	const driver = new LimeSDRDevice().lime;
	await driver.open(usb);
	return { driver, usb, packets };
}

describe('LimeSDR USB access', () => {
	it('explains the Windows driver requirement when USB access is denied', async () => {
		const { driver, usb } = await createDriver();
		usb.open.mockRejectedValueOnce(new DOMException("Failed to execute 'open' on 'USBDevice': Access denied", 'SecurityError'));
		usb.selectConfiguration.mockClear();
		usb.claimInterface.mockClear();
		await expect(driver.open(usb)).rejects.toThrow('WinUSB, not the Cypress CYUSB3 driver');
		expect(usb.close).toHaveBeenCalledOnce();
		expect(usb.selectConfiguration).not.toHaveBeenCalled();
		expect(usb.claimInterface).not.toHaveBeenCalled();
	});

	it('releases the device when claiming an interface fails', async () => {
		const { driver, usb } = await createDriver();
		const error = new Error('Interface is already claimed');
		usb.claimInterface.mockRejectedValueOnce(error);
		await expect(driver.open(usb)).rejects.toBe(error);
		expect(usb.close).toHaveBeenCalledOnce();
	});

	it('preserves the original failure if USB cleanup also fails', async () => {
		const { driver, usb } = await createDriver();
		const error = new Error('Device disconnected');
		usb.open.mockRejectedValueOnce(error);
		usb.close.mockRejectedValueOnce(new Error('Already disconnected'));
		await expect(driver.open(usb)).rejects.toBe(error);
	});
});

describe('LimeSDR LMS64C commands', () => {
	it('encodes LMS register writes without a raw SPI write flag', async () => {
		const { driver, usb, packets } = await createDriver();
		await driver.writeLMS7002(0x040c, 0x1234);
		expect(usb.transferOut).toHaveBeenCalledWith(15, expect.any(Uint8Array));
		expect(usb.transferIn).toHaveBeenCalledWith(15, 64);
		expect(Array.from(packets[0].slice(0, 4))).toEqual([0x21, 0, 1, 0]);
		expect(Array.from(packets[0].slice(8, 12))).toEqual([0x04, 0x0c, 0x12, 0x34]);
	});

	it('preserves FPGA register addresses, including chip select', async () => {
		const { driver, packets } = await createDriver();
		await driver.writeFPGA(0x000a, 1);
		await driver.writeFPGA(0xffff, 1);
		expect(Array.from(packets[0].slice(8, 12))).toEqual([0, 0x0a, 0, 1]);
		expect(Array.from(packets[1].slice(8, 12))).toEqual([0xff, 0xff, 0, 1]);
		expect(await driver.readFPGA(0xffff)).toBe(0x1234);
		expect(Array.from(packets[2].slice(8, 10))).toEqual([0xff, 0xff]);
	});

	it('counts two-byte read addresses as register blocks', async () => {
		const { driver, packets } = await createDriver();
		expect(await driver.readLMS7002(0x010c)).toBe(0x1234);
		expect(packets[0][2]).toBe(1);
		await driver.sendCommand(0x22, new Uint8Array([0x01, 0x0c, 0x01, 0x0d]));
		expect(packets[1][2]).toBe(2);
	});

	it('sends a single reset pulse block during initialization', async () => {
		const { driver, usb, packets } = await createDriver();
		usb.transferIn.mockResolvedValueOnce({ status: 'stall' });
		await expect(driver.initialize()).rejects.toThrow('USB command response failed');
		expect(packets[0][0]).toBe(0x20);
		expect(packets[0][2]).toBe(1);
		expect(packets[0][8]).toBe(2);
	});

	it('splits register batches into fourteen-register packets', async () => {
		const { driver, packets } = await createDriver();
		const registers = Array.from({ length: 15 }, (_, index) => [0x0400 + index, index]);
		await driver.writeLMS7002Batch(registers);
		expect(packets.map(packet => packet[2])).toEqual([14, 1]);
		expect(Array.from(packets[0].slice(8, 12))).toEqual([0x04, 0, 0, 0]);
		expect(Array.from(packets[1].slice(8, 12))).toEqual([0x04, 0x0e, 0, 0x0e]);
	});

	it('does not cache rejected writes and recovers after firmware errors', async () => {
		const { driver, usb } = await createDriver();
		const response = new Uint8Array(64);
		response[0] = 0x21;
		response[1] = 2;
		usb.transferIn.mockResolvedValueOnce({ status: 'ok', data: new DataView(response.buffer) });
		await expect(driver.writeLMS7002Batch([[0x040c, 0x1234]])).rejects.toThrow('device status=2');
		expect(driver.regCache.has(0x040c)).toBe(false);
		await driver.writeLMS7002(0x040c, 0x5678);
		expect(driver.regCache.get(0x040c)).toBe(0x5678);
	});

	it.each([
		{ status: 'stall', bytesWritten: 0 },
		{ status: 'ok', bytesWritten: 32 },
	])('rejects failed or short command writes (%j)', async result => {
		const { driver, usb } = await createDriver();
		usb.transferOut.mockResolvedValueOnce(result);
		await expect(driver.writeFPGA(0x000a, 1)).rejects.toThrow('USB command write failed');
		expect(usb.transferIn).not.toHaveBeenCalled();
	});

	it.each([
		{ status: 'stall' },
		{ status: 'ok', data: new DataView(new ArrayBuffer(16)) },
		{ status: 'ok' },
	])('rejects failed, truncated, or missing responses (%j)', async result => {
		const { driver, usb } = await createDriver();
		usb.transferIn.mockResolvedValueOnce(result);
		await expect(driver.readFPGA(0x000a)).rejects.toThrow('USB command response failed');
	});

	it('rejects responses for another command', async () => {
		const { driver, usb } = await createDriver();
		const response = new Uint8Array(64);
		response[0] = 0x21;
		response[1] = 1;
		usb.transferIn.mockResolvedValueOnce({ status: 'ok', data: new DataView(response.buffer) });
		await expect(driver.readFPGA(0x000a)).rejects.toThrow('unexpected command response');
	});

	it('serializes complete request-response exchanges', async () => {
		const { driver, usb } = await createDriver();
		const events = [];
		let releaseFirstResponse;
		usb.transferOut.mockImplementation(async (endpoint, packet) => {
			events.push(`write:${packet[0]}`);
			return { status: 'ok', bytesWritten: 64 };
		});
		usb.transferIn.mockImplementationOnce(() => {
			events.push('read:first');
			return new Promise(resolve => {
				releaseFirstResponse = () => {
					const response = new Uint8Array(64);
					response[0] = 0x21;
					response[1] = 1;
					resolve({ status: 'ok', data: new DataView(response.buffer) });
				};
			});
		});
		usb.transferIn.mockImplementationOnce(async () => {
			events.push('read:second');
			const response = new Uint8Array(64);
			response[0] = 0x55;
			response[1] = 1;
			return { status: 'ok', data: new DataView(response.buffer) };
		});
		const first = driver.writeLMS7002(0x040c, 1);
		const second = driver.writeFPGA(0x000a, 1);
		await vi.waitFor(() => expect(releaseFirstResponse).toBeTypeOf('function'));
		expect(events).toEqual(['write:33', 'read:first']);
		releaseFirstResponse();
		await Promise.all([first, second]);
		expect(events).toEqual(['write:33', 'read:first', 'write:85', 'read:second']);
	});

	it('rejects invalid payload lengths without USB traffic', async () => {
		const { driver, usb } = await createDriver();
		await expect(driver.sendCommand(0x21, new Uint8Array(3))).rejects.toThrow('invalid payload');
		await expect(driver.sendCommand(0x21, new Uint8Array(60))).rejects.toThrow('invalid payload');
		await expect(driver.sendCommand(0x22, new Uint8Array(30))).rejects.toThrow('invalid payload');
		expect(usb.transferOut).not.toHaveBeenCalled();
	});
});

describe('LimeSDR receive configuration', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('allows firmware that does not implement the USB FIFO reset command', async () => {
		const { driver, usb, packets } = await createDriver();
		const response = new Uint8Array(64);
		response[0] = 0x40;
		response[1] = 2;
		usb.transferIn.mockResolvedValueOnce({ status: 'ok', data: new DataView(response.buffer) });
		await expect(driver.resetStreamBuffers()).resolves.toBeUndefined();
		expect(Array.from(packets[0].slice(0, 4))).toEqual([0x40, 0, 1, 0]);
	});

	it.each([3, 5, 6])('does not hide FIFO reset firmware failures (status=%i)', async status => {
		const { driver, usb } = await createDriver();
		const response = new Uint8Array(64);
		response[0] = 0x40;
		response[1] = status;
		usb.transferIn.mockResolvedValueOnce({ status: 'ok', data: new DataView(response.buffer) });
		await expect(driver.resetStreamBuffers()).rejects.toThrow(`device status=${status}`);
	});

	it('resets logic without resetting configuration memory or changing channel enables', async () => {
		const { driver } = await createDriver();
		vi.spyOn(driver, 'readLMS7002').mockResolvedValue(0xff15);
		const write = vi.spyOn(driver, 'writeLMS7002').mockResolvedValue(undefined);
		await driver.resetLogicRegisters();
		expect(write.mock.calls).toEqual([[0x0020, 0x5515], [0x0020, 0xff15]]);
		for (const [, value] of write.mock.calls) {
			expect(value & 0x5500).toBe(0x5500);
			expect(value & 0x00ff).toBe(0x15);
		}
	});

	it('sets the CGEN rate to eight times the requested oversampled rate', async () => {
		const { driver } = await createDriver();
		const cgen = vi.spyOn(driver, 'setCGENFrequency').mockResolvedValue(undefined);
		vi.spyOn(driver, 'setAnalogBandwidth').mockResolvedValue(undefined);
		vi.spyOn(driver, 'configureRxTSP').mockResolvedValue(undefined);
		vi.spyOn(driver, 'configureLML').mockResolvedValue(undefined);
		vi.spyOn(driver, 'configureFPGAPLL').mockResolvedValue(undefined);
		await driver.setSampleRate(10e6);
		expect(cgen).toHaveBeenCalledWith(80e6);
		await expect(driver.setSampleRate(NaN)).rejects.toThrow('unsupported sample rate');
		await expect(driver.setSampleRate(0)).rejects.toThrow('unsupported sample rate');
		expect(cgen).toHaveBeenCalledTimes(1);
	});

	it.each([30.72e6, 40e6, 50e6, 61.44e6])('configures the full receive rate with two-times oversampling (%i)', async rate => {
		const { driver } = await createDriver();
		const cgen = vi.spyOn(driver, 'setCGENFrequency').mockResolvedValue(undefined);
		const bandwidth = vi.spyOn(driver, 'setAnalogBandwidth').mockResolvedValue(undefined);
		const modify = vi.spyOn(driver, 'modifyReg').mockResolvedValue(undefined);
		vi.spyOn(driver, 'configureLML').mockResolvedValue(undefined);
		vi.spyOn(driver, 'configureFPGAPLL').mockResolvedValue(undefined);
		await driver.setSampleRate(rate);
		expect(cgen).toHaveBeenCalledWith(rate * 8);
		expect(bandwidth).toHaveBeenCalledWith(rate);
		expect(modify).toHaveBeenCalledWith(0x403, 14, 12, 0);
		expect(driver.currentSampleRate).toBe(rate);
		await expect(driver.setSampleRate(61.44e6 + 1)).rejects.toThrow('unsupported sample rate');
	});

	it('advertises receive rates up to 61.44 MSPS', () => {
		expect(new LimeSDRDevice().sampleRates).toEqual([1e6, 2e6, 5e6, 10e6, 20e6, 30.72e6, 40e6, 50e6, 61.44e6]);
	});

	it.each([40e6, 50e6, 61.44e6])('keeps the high-rate CGEN VCO within its operating range (%i)', async rate => {
		const { driver } = await createDriver();
		vi.spyOn(driver, 'modifyReg').mockResolvedValue(undefined);
		vi.spyOn(driver, 'readLMS7002').mockResolvedValue(0x1000);
		const batch = vi.spyOn(driver, 'writeLMS7002Batch').mockResolvedValue(undefined);
		vi.spyOn(driver, 'tuneVCO').mockResolvedValue(true);
		await driver.setCGENFrequency(rate * 8);
		const divider = (batch.mock.calls[0][0][2][1] >> 3) & 255;
		const vco = 2 * (divider + 1) * rate * 8;
		expect(vco).toBeGreaterThanOrEqual(1930e6);
		expect(vco).toBeLessThanOrEqual(2940e6);
	});

	it('uses the 122.88 MHz interface clock at the maximum receive rate', async () => {
		const { driver } = await createDriver();
		driver.currentSampleRate = 61.44e6;
		const pll = vi.spyOn(driver, 'programFPGAPLL').mockResolvedValue(undefined);
		vi.spyOn(driver, 'resetLogicRegisters').mockResolvedValue(undefined);
		await driver.configureFPGAPLL();
		expect(pll).toHaveBeenCalledWith(1, 122.88e6, [122.88e6, 122.88e6], [0, expect.closeTo(241.8312)]);
	});

	it('does not clamp the maximum-rate analog filter to 40 MHz', async () => {
		const { driver } = await createDriver();
		const modify = vi.spyOn(driver, 'modifyReg').mockResolvedValue(undefined);
		const tia = vi.spyOn(driver, 'configureTIAFilter').mockResolvedValue(undefined);
		await driver.setAnalogBandwidth(61.44e6);
		expect(tia).toHaveBeenCalledWith(30.72e6);
		expect(modify).toHaveBeenCalledWith(0x115, 3, 2, 1);
		expect(modify).toHaveBeenCalledWith(0x118, 15, 13, 1);
		expect(modify).toHaveBeenCalledWith(0x116, 10, 0, 100);
	});

	it('configures PLL clocks and phase using the oversampled interface rate', async () => {
		const { driver } = await createDriver();
		const pll = vi.spyOn(driver, 'programFPGAPLL').mockResolvedValue(undefined);
		const reset = vi.spyOn(driver, 'resetLogicRegisters').mockResolvedValue(undefined);
		await driver.configureFPGAPLL();
		expect(pll.mock.calls).toEqual([
			[0, 20e6, [20e6, 20e6], [0, expect.closeTo(95.03)]],
			[1, 20e6, [20e6, 20e6], [0, expect.closeTo(114.26)]],
		]);
		expect(reset).toHaveBeenCalledOnce();
	});

	it.each([
		[0x0e, 2, 22, 10e6, true],
		[0x0e, 2, 14, 10e6, false],
		[0x0e, 1, 22, 10e6, false],
		[0x0f, 2, 22, 10e6, false],
		[0x0e, 2, 22, 2e6, false],
	])('gates RX phase search on board, gateware and rate (%i, %i.%i, %i)', async (board, version, revision, rate, supported) => {
		const { driver } = await createDriver();
		driver.currentSampleRate = rate;
		vi.spyOn(driver, 'readFPGA').mockImplementation(async address => [board, version, revision][address]);
		vi.spyOn(driver, 'programFPGAPLL').mockResolvedValue(undefined);
		vi.spyOn(driver, 'resetLogicRegisters').mockResolvedValue(undefined);
		const align = vi.spyOn(driver, 'alignRXClock').mockResolvedValue(undefined);
		await driver.configureFPGAPLL();
		expect(align).toHaveBeenCalledTimes(supported ? 1 : 0);
	});

	it.each([false, true])('restores both register banks after RX clock alignment (failure=%s)', async failure => {
		const { driver } = await createDriver();
		let bank = 1;
		vi.spyOn(driver, 'readLMS7002').mockImplementation(async address => address === 0x20
			? 0xfffd : address >= 0x100 ? bank * 0x1000 + address : address);
		const write = vi.spyOn(driver, 'writeLMS7002').mockImplementation(async (address, value) => {
			if (address === 0x20) bank = value & 3;
		});
		const batch = vi.spyOn(driver, 'writeLMS7002Batch').mockResolvedValue(undefined);
		const pll = vi.spyOn(driver, 'programFPGAPLL');
		if (failure) pll.mockRejectedValue(new Error('Phase search failed'));
		else pll.mockResolvedValue(undefined);
		const aligning = driver.alignRXClock(20e6, 20e6);
		if (failure) await expect(aligning).rejects.toThrow('Phase search failed');
		else await aligning;
		expect(batch.mock.calls[1][0]).toEqual([[0x400, 0x2400], [0x40c, 0x240c], [0x40b, 0x240b]]);
		expect(batch.mock.calls[2][0]).toContainEqual([0x400, 0x1400]);
		expect(write.mock.calls.at(-1)).toEqual([0x20, 0xfffd]);
	});

	it.each([4, 12, 0])('checks phase-search completion and clears its start bit (status=%i)', async status => {
		vi.useFakeTimers();
		const { driver } = await createDriver();
		vi.spyOn(driver, 'readFPGA').mockImplementation(async address => address === 0x21 ? status : 0);
		const write = vi.spyOn(driver, 'writeFPGA').mockResolvedValue(undefined);
		const configuring = driver.programFPGAPLL(1, 20e6, [20e6, 20e6], [], true);
		const result = status === 4 ? expect(configuring).resolves.toBeUndefined()
			: expect(configuring).rejects.toThrow(status === 12 ? 'phase search failed' : 'phase search timed out');
		await vi.advanceTimersByTimeAsync(3100);
		await result;
		expect(write).toHaveBeenCalledWith(0x24, 239);
		expect(write.mock.calls.at(-1)[1] & 2).toBe(0);
	});

	it('invalidates banked cached registers when selecting another channel', async () => {
		const { driver } = await createDriver();
		await driver.writeLMS7002(0x20, 0xfffd);
		await driver.writeLMS7002(0x400, 0x8081);
		await driver.writeLMS7002(0x22, 0x0fff);
		await driver.writeLMS7002(0x20, 0xfffe);
		expect(driver.regCache.has(0x400)).toBe(false);
		expect(driver.regCache.get(0x22)).toBe(0x0fff);
	});

	it('selects the low-pass receive path and uses half of the RF bandwidth', async () => {
		const { driver } = await createDriver();
		const modify = vi.spyOn(driver, 'modifyReg').mockResolvedValue(undefined);
		vi.spyOn(driver, 'readLMS7002').mockResolvedValue(3);
		await driver.setAnalogBandwidth(10e6);
		expect(modify).toHaveBeenCalledWith(0x115, 3, 2, 2);
		expect(modify).toHaveBeenCalledWith(0x118, 15, 13, 0);
		expect(modify).toHaveBeenCalledWith(0x117, 13, 0, (3 << 11) | 229);
		expect(modify).toHaveBeenCalledWith(0x112, 15, 0, (4 << 12) | 456);
		expect(modify).toHaveBeenCalledWith(0x114, 8, 5, 11);
		expect(modify.mock.calls.some(([address]) => address === 0x11a || address === 0x119)).toBe(false);
	});

	it('selects the high-frequency low-pass path for wider bandwidths', async () => {
		const { driver } = await createDriver();
		const modify = vi.spyOn(driver, 'modifyReg').mockResolvedValue(undefined);
		vi.spyOn(driver, 'readLMS7002').mockResolvedValue(3);
		await driver.setAnalogBandwidth(40e6);
		expect(modify).toHaveBeenCalledWith(0x115, 3, 2, 1);
		expect(modify).toHaveBeenCalledWith(0x118, 15, 13, 1);
		expect(modify).toHaveBeenCalledWith(0x116, 10, 0, 180);
	});

	it.each([[0, 3], [8, 2], [16, 1], [31, 0]])('adjusts PGA compensation with gain (%i)', async (gain, capacitor) => {
		const { driver } = await createDriver();
		const modify = vi.spyOn(driver, 'modifyReg').mockResolvedValue(undefined);
		await driver.setPGAGain(gain);
		expect(modify).toHaveBeenCalledWith(0x119, 4, 0, gain);
		expect(modify).toHaveBeenCalledWith(0x11a, 6, 0, capacitor);
		expect(modify).toHaveBeenCalledWith(0x11a, 13, 9, expect.any(Number));
	});

	it('retunes TIA compensation after changing TIA gain', async () => {
		const { driver } = await createDriver();
		vi.spyOn(driver, 'modifyReg').mockResolvedValue(undefined);
		const filter = vi.spyOn(driver, 'configureTIAFilter').mockResolvedValue(undefined);
		await driver.setTIAGain(0);
		expect(filter).toHaveBeenCalledWith(5e6);
	});

	it('selects the ADC clock source and DAC clock divider explicitly', async () => {
		const { driver } = await createDriver();
		const modify = vi.spyOn(driver, 'modifyReg').mockResolvedValue(undefined);
		vi.spyOn(driver, 'readLMS7002').mockResolvedValue(0x1000);
		const batch = vi.spyOn(driver, 'writeLMS7002Batch').mockResolvedValue(undefined);
		vi.spyOn(driver, 'tuneVCO').mockResolvedValue(true);
		await driver.setCGENFrequency(40e6);
		expect(modify).toHaveBeenCalledWith(0x0086, 11, 11, 0);
		expect(modify).toHaveBeenCalledWith(0x0089, 12, 11, 2);
		expect(batch.mock.calls[0][0][2][1] & 0x1800).toBe(0x1000);
	});

	it('fails configuration instead of streaming with an unlocked CGEN', async () => {
		const { driver } = await createDriver();
		vi.spyOn(driver, 'modifyReg').mockResolvedValue(undefined);
		vi.spyOn(driver, 'readLMS7002').mockResolvedValue(0x1000);
		vi.spyOn(driver, 'writeLMS7002Batch').mockResolvedValue(undefined);
		vi.spyOn(driver, 'tuneVCO').mockResolvedValue(false);
		await expect(driver.setCGENFrequency(40e6)).rejects.toThrow('CGEN VCO failed to lock');
	});

	it('uses direct clocking below the PLL minimum frequency', async () => {
		const { driver } = await createDriver();
		vi.spyOn(driver, 'readFPGA').mockResolvedValue(1);
		const write = vi.spyOn(driver, 'writeFPGA').mockResolvedValue(undefined);
		await driver.programFPGAPLL(1, 2e6, [4e6, 4e6]);
		expect(write.mock.calls).toEqual([[0x0005, 3]]);
	});

	it.each([0, 1])('waits for RX channel %i samples and preserves I/Q order without live-packet calibration', async channel => {
		const { driver, usb } = await createDriver();
		driver.rxChannel = channel;
		vi.spyOn(driver, 'readFPGA').mockResolvedValue(0);
		const fpgaWrite = vi.spyOn(driver, 'writeFPGA').mockResolvedValue(undefined);
		vi.spyOn(driver, 'readLMS7002').mockResolvedValue(0xff15);
		const lmsWrite = vi.spyOn(driver, 'writeLMS7002').mockResolvedValue(undefined);
		const readResolvers = [];
		usb.transferIn.mockImplementation(endpoint => {
			if (endpoint === 15) {
				const response = new Uint8Array(64);
				response[0] = 0x40;
				response[1] = 1;
				return Promise.resolve({ status: 'ok', data: new DataView(response.buffer) });
			}
			return new Promise(resolve => readResolvers.push(resolve));
		});
		const callback = vi.fn();
		let active = false;
		const starting = driver.startStreaming(callback).then(() => { active = true; });
		await vi.waitFor(() => expect(readResolvers).toHaveLength(8));
		expect(active).toBe(false);
		const packet = new DataView(new ArrayBuffer(4096));
		for (let offset = 16; offset < 4096; offset += 4) {
			packet.setInt16(offset, 16384, true);
			packet.setInt16(offset + 2, -2048, true);
		}
		readResolvers.shift()({ status: 'ok', data: packet });
		await starting;
		expect(fpgaWrite).toHaveBeenCalledWith(0x0007, 1 << channel);
		expect(active).toBe(true);
		expect(callback).toHaveBeenCalledOnce();
		expect(callback.mock.calls[0][0]).toHaveLength(2040);
		expect(Array.from(callback.mock.calls[0][0].slice(0, 4))).toEqual([64, -8, 64, -8]);
		expect(lmsWrite.mock.calls).toEqual([[0x0020, 0x5515], [0x0020, 0xff15]]);
		const stopping = driver.stopStreaming();
		for (const resolve of readResolvers) resolve({ status: 'ok', data: packet });
		await stopping;
		expect(callback).toHaveBeenCalledOnce();
		expect(usb.close).not.toHaveBeenCalled();
	});

	it('reports missing USB data and cancels blocked transfers instead of hanging', async () => {
		vi.useFakeTimers();
		const { driver, usb } = await createDriver();
		vi.spyOn(driver, 'readFPGA').mockResolvedValue(0);
		vi.spyOn(driver, 'writeFPGA').mockResolvedValue(undefined);
		vi.spyOn(driver, 'readLMS7002').mockResolvedValue(0xff15);
		vi.spyOn(driver, 'writeLMS7002').mockResolvedValue(undefined);
		const readResolvers = [];
		usb.transferIn.mockImplementation(endpoint => {
			if (endpoint === 15) {
				const response = new Uint8Array(64);
				response[0] = 0x40;
				response[1] = 1;
				return Promise.resolve({ status: 'ok', data: new DataView(response.buffer) });
			}
			return new Promise(resolve => readResolvers.push(resolve));
		});
		usb.close.mockImplementation(async () => {
			for (const resolve of readResolvers) resolve({ status: 'stall' });
		});
		const callback = vi.fn();
		const starting = driver.startStreaming(callback);
		const failure = expect(starting).rejects.toThrow('no USB IQ samples received');
		await vi.advanceTimersByTimeAsync(0);
		expect(readResolvers).toHaveLength(8);
		await vi.advanceTimersByTimeAsync(4000);
		await failure;
		expect(usb.close).toHaveBeenCalledOnce();
		expect(usb.open).toHaveBeenCalledTimes(2);
		expect(usb.selectConfiguration).toHaveBeenLastCalledWith(1);
		expect(usb.claimInterface).toHaveBeenLastCalledWith(0);
		expect(callback).not.toHaveBeenCalled();
		expect(driver.rxRunning).toBeNull();
	});
});

describe('LimeSDR RX channel selection', () => {
	afterEach(() => vi.restoreAllMocks());

	it('advertises RX1 and RX2 with RX1 as the default', () => {
		expect(new LimeSDRDevice().gainControls[0]).toMatchObject({
			name: 'RX Channel', min: 0, max: 1, default: 0, labels: ['RX1', 'RX2'], type: 'select',
		});
	});

	it.each([0, 1])('routes LO from bank A before selecting RX channel %i and its FPGA mask', async channel => {
		const { driver } = await createDriver();
		const modify = vi.spyOn(driver, 'modifyReg').mockResolvedValue(undefined);
		const bandwidth = vi.spyOn(driver, 'setAnalogBandwidth').mockResolvedValue(undefined);
		const fpga = vi.spyOn(driver, 'writeFPGA').mockResolvedValue(undefined);
		await driver.setRxChannel(channel);
		expect(modify.mock.calls).toEqual([[0x0020, 1, 0, 1], [0x010d, 0, 0, channel], [0x0020, 1, 0, channel + 1]]);
		expect(bandwidth).toHaveBeenCalledWith(10e6);
		expect(fpga).toHaveBeenCalledWith(0x0007, 1 << channel);
		expect(driver.rxChannel).toBe(channel);
	});

	it.each([-1, 2, NaN, 0.5])('rejects invalid RX channel %s before USB writes', async channel => {
		const { driver, usb } = await createDriver();
		await expect(driver.setRxChannel(channel)).rejects.toThrow('unsupported RX channel');
		expect(usb.transferOut).not.toHaveBeenCalled();
	});

	it.each([false, true])('tunes the shared RX LO in bank A and restores RX2 (failure=%s)', async failure => {
		const { driver } = await createDriver();
		driver.rxChannel = 1;
		const modify = vi.spyOn(driver, 'modifyReg').mockResolvedValue(undefined);
		vi.spyOn(driver, 'readLMS7002').mockResolvedValue(0);
		vi.spyOn(driver, 'writeLMS7002').mockResolvedValue(undefined);
		vi.spyOn(driver, 'tuneVCO').mockResolvedValue(!failure);
		if (failure) await expect(driver.setFrequencySXR(106.4e6)).rejects.toThrow('SX VCO failed to lock');
		else await driver.setFrequencySXR(106.4e6);
		expect(modify.mock.calls[0]).toEqual([0x0020, 1, 0, 1]);
		expect(modify).toHaveBeenLastCalledWith(0x0020, 1, 0, 2);
	});

	it.each([false, true])('restores RX2 after sample-rate configuration (failure=%s)', async failure => {
		const { driver } = await createDriver();
		driver.rxChannel = 1;
		const modify = vi.spyOn(driver, 'modifyReg').mockResolvedValue(undefined);
		vi.spyOn(driver, 'setCGENFrequency').mockResolvedValue(undefined);
		vi.spyOn(driver, 'setAnalogBandwidth').mockResolvedValue(undefined);
		vi.spyOn(driver, 'configureRxTSP').mockResolvedValue(undefined);
		vi.spyOn(driver, 'configureLML').mockResolvedValue(undefined);
		const pll = vi.spyOn(driver, 'configureFPGAPLL').mockResolvedValue(undefined);
		if (failure) pll.mockRejectedValue(new Error('PLL failure'));
		if (failure) await expect(driver.setSampleRate(61.44e6)).rejects.toThrow('PLL failure');
		else await driver.setSampleRate(61.44e6);
		expect(modify).toHaveBeenCalledWith(0x0020, 1, 0, 3);
		expect(modify).toHaveBeenLastCalledWith(0x0020, 1, 0, 2);
	});

	function createWrapper() {
		const device = new LimeSDRDevice();
		const events = [];
		for (const method of ['startStreaming', 'stopStreaming', 'setRxChannel', 'setLNAGain', 'setTIAGain', 'setPGAGain', 'setAntennaPath', 'setFrequencySXR']) {
			vi.spyOn(device.lime, method).mockImplementation(async value => { events.push([method, value]); });
		}
		return { device, events };
	}

	it('stops reception, applies retained gains and path to RX2, then restarts the same callback', async () => {
		const { device, events } = createWrapper();
		const callback = vi.fn();
		await device.setGains({ LNA: 20, TIA: 1, PGA: 18, Antenna: 2 });
		await device.startRx(callback);
		events.length = 0;
		await device.setGain('RX Channel', 1);
		expect(events).toEqual([
			['stopStreaming', undefined], ['setRxChannel', 1], ['setLNAGain', 20],
			['setTIAGain', 1], ['setPGAGain', 18], ['setAntennaPath', 2], ['startStreaming', callback],
		]);
	});

	it('selects the receiver before initial gains regardless of dictionary order and does not start streaming', async () => {
		const { device, events } = createWrapper();
		await device.setGains({ Antenna: 2, LNA: 25, 'RX Channel': 1 });
		expect(events[0]).toEqual(['setRxChannel', 1]);
		expect(device.lime.setLNAGain).toHaveBeenCalledWith(25);
		expect(device.lime.setAntennaPath).toHaveBeenCalledWith(2);
		expect(device.lime.startStreaming).not.toHaveBeenCalled();
	});

	it('does not restart reception when the selected receiver has not changed', async () => {
		const { device, events } = createWrapper();
		await device.startRx(vi.fn());
		events.length = 0;
		await device.setGains({ 'RX Channel': 0, Antenna: 2 });
		expect(events).toEqual([['setAntennaPath', 2]]);
	});

	it('serializes switching, retuning, and stopping so a switch cannot restart a stopped stream', async () => {
		const { device, events } = createWrapper();
		await device.startRx(vi.fn());
		events.length = 0;
		await Promise.all([device.setGain('RX Channel', 1), device.setFrequency(106.4e6), device.stopRx()]);
		expect(events.slice(-3)).toEqual([
			['startStreaming', expect.any(Function)], ['setFrequencySXR', 106.4e6], ['stopStreaming', undefined],
		]);
		await device.setGain('RX Channel', 0);
		expect(device.lime.startStreaming).toHaveBeenCalledTimes(2);
	});

	it('restores the old receiver and stream after a failed switch and allows retry', async () => {
		const { device } = createWrapper();
		const callback = vi.fn();
		await device.setGain('Antenna', 2);
		await device.startRx(callback);
		device.lime.setRxChannel.mockRejectedValueOnce(new Error('Channel switch failed'));
		await expect(device.setGain('RX Channel', 1)).rejects.toThrow('Channel switch failed');
		expect(device.lime.setRxChannel).toHaveBeenLastCalledWith(0);
		expect(device.lime.setAntennaPath).toHaveBeenLastCalledWith(2);
		expect(device.lime.startStreaming).toHaveBeenLastCalledWith(callback);
		expect(device.gains['RX Channel']).toBe(0);
		await device.setGain('RX Channel', 1);
		expect(device.gains['RX Channel']).toBe(1);
	});
});
