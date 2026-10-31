import { afterEach, describe, expect, it, vi } from 'vitest';
import { AirspyDevice } from '@/devices/airspy';
import { AirspyIqConverter } from '@/devices/airspy/iq-converter';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function view(bytes, offset = 3) {
	const buffer = new Uint8Array(bytes.length + offset + 7).fill(0xab);
	buffer.set(bytes, offset);
	return new DataView(buffer.buffer, offset, bytes.length);
}

function radio(rates = [10000000, 2500000]) {
	const pending = [];
	const finish = () => pending.splice(0).forEach(({ resolve }) => resolve({ status: 'ok', data: view([0, 8, 0, 8]) }));
	const usb = {
		open: vi.fn(async () => {}),
		selectConfiguration: vi.fn(async () => {}),
		claimInterface: vi.fn(async () => {}),
		clearHalt: vi.fn(async () => {}),
		close: vi.fn(async () => finish()),
		controlTransferIn: vi.fn(async (setup, length) => {
			if (setup.request === 25) {
				const values = setup.index === 0 ? [rates.length] : rates;
				const bytes = new Uint8Array(values.length * 4);
				values.forEach((rate, i) => new DataView(bytes.buffer).setUint32(i * 4, rate, true));
				return { status: 'ok', data: view(bytes) };
			}
			if (setup.request === 10) return { status: 'ok', data: view(new TextEncoder().encode('AirSpy NOS v1.0.0\0')) };
			return { status: 'ok', data: view(new Uint8Array(length)) };
		}),
		controlTransferOut: vi.fn(async (setup) => {
			if (setup.request === 1 && setup.value === 0) finish();
			return { status: 'ok', bytesWritten: 0 };
		}),
		transferIn: vi.fn(() => new Promise((resolve, reject) => pending.push({ resolve, reject }))),
	};
	return { usb, pending };
}

async function connected(rates) {
	const fixture = radio(rates);
	const device = new AirspyDevice();
	await device.open(fixture.usb);
	return { ...fixture, device };
}

async function flush() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

// R820T high-side LO: RF above center produces IF below Fs/4.
function adcTone(offset, count = 32768) {
	const bytes = new Uint8Array(count * 2);
	const data = new DataView(bytes.buffer);
	for (let n = 0; n < count; n++) {
		data.setUint16(n * 2, Math.round(2048 + 1200 * Math.cos(2 * Math.PI * (0.25 - offset / 2) * n)), true);
	}
	return bytes;
}

function amplitude(iq, frequency) {
	let real = 0,
		imag = 0;
	const start = 512;
	for (let n = start; n < iq.length / 2; n++) {
		const phase = 2 * Math.PI * frequency * n;
		real += iq[n * 2] * Math.cos(phase) + iq[n * 2 + 1] * Math.sin(phase);
		imag += iq[n * 2 + 1] * Math.cos(phase) - iq[n * 2] * Math.sin(phase);
	}
	return Math.hypot(real, imag) / (iq.length / 2 - start);
}

describe('Airspy USB protocol', () => {
	it.each([
		[10000000, 2500000],
		[2500000, 10000000],
		[6000000, 3000000],
	])('uses firmware indices with sorted UI rates %j', async (...rates) => {
		const { device, usb } = await connected(rates);
		expect(device.sampleRates).toEqual([...rates].sort((a, b) => a - b));
		for (let index = 0; index < rates.length; index++) {
			await device.setSampleRate(rates[index]);
			expect(usb.controlTransferIn).toHaveBeenLastCalledWith(expect.objectContaining({ request: 12, value: 0, index }), 1);
		}
		await expect(device.setSampleRate(1234)).rejects.toThrow('unsupported sample rate');
	});
	it('falls back to legacy R2 firmware indices after a stalled query', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { usb } = radio();
		usb.controlTransferIn.mockResolvedValueOnce({ status: 'stall' });
		const device = new AirspyDevice();
		await device.open(usb);
		await device.setSampleRate(2500000);
		expect(usb.controlTransferIn).toHaveBeenLastCalledWith(expect.objectContaining({ request: 12, index: 1 }), 1);
	});
	it('rejects short mandatory control responses', async () => {
		const { device, usb } = await connected();
		usb.controlTransferIn.mockResolvedValueOnce({ status: 'ok', data: view([]) });
		await expect(device.setSampleRate(10000000)).rejects.toThrow('short vendor IN');
	});
	it('reads one-byte board IDs and short firmware strings without surrounding buffer bytes', async () => {
		const { device, usb } = await connected();
		expect(await device.getInfo()).toEqual({ name: 'Airspy One', firmware: 'AirSpy NOS v1.0.0', serial: '0'.repeat(32) });
		expect(usb.controlTransferIn).toHaveBeenCalledWith(expect.objectContaining({ request: 9 }), 1);
		expect(usb.controlTransferIn).toHaveBeenCalledWith(expect.objectContaining({ request: 10 }), 127);
	});
	it('uses IN gain/AGC requests, clamps gains and routes Bias-T through GPIO 1/13', async () => {
		const { device, usb } = await connected();
		await device.setGain('LNA', 99);
		await device.setGain('Mixer', -1);
		await device.setGain('VGA', 8);
		for (const [request, index] of [
			[17, 0],
			[14, 14],
			[18, 0],
			[15, 0],
			[16, 8],
		]) {
			expect(usb.controlTransferIn).toHaveBeenCalledWith(expect.objectContaining({ request, value: 0, index }), 1);
		}
		await device.setGain('Bias-T', 1);
		expect(usb.controlTransferOut).toHaveBeenLastCalledWith(expect.objectContaining({ request: 21, value: 1, index: 45 }), undefined);
		await device.setFrequency(92100000);
		const [setup, data] = usb.controlTransferOut.mock.lastCall;
		expect(setup.request).toBe(13);
		expect(new DataView(data).getUint32(0, true)).toBe(92100000);
	});
});

describe('Airspy real ADC to IQ', () => {
	it.each([-0.18, -0.05, 0.05, 0.18])('preserves tone orientation and rejects the mirrored image at %s of IQ rate', (offset) => {
		const iq = new AirspyIqConverter().process(view(adcTone(offset)));
		expect(iq).toBeInstanceOf(Int8Array);
		expect(iq.length).toBe(32768);
		const wanted = amplitude(iq, offset);
		const image = amplitude(iq, -offset);
		expect(wanted).toBeGreaterThan(35);
		expect(20 * Math.log10(wanted / image)).toBeGreaterThan(40);
	});
	it('removes ADC midpoint and residual DC without wraparound', () => {
		const bytes = new Uint8Array(8192);
		const data = new DataView(bytes.buffer);
		for (let n = 0; n < bytes.length; n += 2) data.setUint16(n, 2345, true);
		const iq = new AirspyIqConverter().process(data);
		expect([...iq.slice(1024)].every((value) => value === 0)).toBe(true);
	});
	it('keeps exact filter/phase state across short and unaligned USB reads', () => {
		const bytes = adcTone(0.05, 4096);
		const expected = new AirspyIqConverter().process(view(bytes));
		const converter = new AirspyIqConverter();
		const output = [];
		for (let start = 0; start < bytes.length;) {
			const size = Math.min((start % 37) + 1, bytes.length - start);
			output.push(...converter.process(view(bytes.slice(start, start + size))));
			start += size;
		}
		expect(output).toEqual([...expected]);
	});
});

describe('Airspy receive lifecycle', () => {
	it('stops reception inherited from a closed browser before any vendor IN request', async () => {
		const { usb } = radio();
		let receiving = true;
		const originalIn = usb.controlTransferIn.getMockImplementation();
		usb.controlTransferIn.mockImplementation(async (...args) => {
			if (receiving) throw new Error('inherited reception blocks control IN');
			return originalIn(...args);
		});
		usb.controlTransferOut.mockImplementation(async (setup) => {
			if (setup.request === 1) receiving = setup.value === 1;
			return { status: 'ok', bytesWritten: 0 };
		});
		const device = new AirspyDevice();
		await device.open(usb);
		expect(receiving).toBe(false);
		expect((await device.getInfo()).name).toBe('Airspy One');
		await device.setSampleRate(10000000);
		expect(usb.controlTransferOut.mock.invocationCallOrder[0]).toBeLessThan(usb.controlTransferIn.mock.invocationCallOrder[0]);
	});
	it('drains active reads before changing sample rate and restarts without unplugging', async () => {
		const { device, usb, pending } = await connected();
		const callback = vi.fn();
		await device.startRx(callback);
		expect(pending).toHaveLength(4);
		await device.setSampleRate(2500000);
		expect(pending).toHaveLength(0);
		expect(callback).not.toHaveBeenCalled();
		expect(usb.close).not.toHaveBeenCalled();
		await device.startRx(callback);
		expect(pending).toHaveLength(4);
		await device.stopRx();
	});
	it('includes the failed request in rejected WebUSB control errors', async () => {
		const { device, usb } = await connected();
		usb.controlTransferIn.mockRejectedValueOnce(new Error('A transfer error has occurred.'));
		await expect(device.setSampleRate(2500000)).rejects.toThrow('req=12, value=0, index=1');
	});
	it('disables packing, queues four reads and consumes completions in submission order', async () => {
		const { device, usb, pending } = await connected();
		const callback = vi.fn();
		await device.startRx(callback);
		expect(device.sampleFormat).toBe('int16');
		expect(usb.controlTransferIn).toHaveBeenLastCalledWith(expect.objectContaining({ request: 26, index: 0 }), 1);
		expect(usb.transferIn).toHaveBeenCalledTimes(4);
		const bytes = adcTone(0.05, 4096);
		const reads = pending.splice(0);
		reads[1].resolve({ status: 'ok', data: view(bytes.slice(1024, 2048)) });
		await flush();
		expect(callback).not.toHaveBeenCalled();
		reads[0].resolve({ status: 'ok', data: view(bytes.slice(0, 1024)) });
		await flush();
		const expected = new AirspyIqConverter(12).process(view(bytes.slice(0, 2048)));
		expect(callback.mock.calls.flatMap(([iq]) => [...iq])).toEqual([...expected]);
		reads.slice(2).forEach(({ resolve }) => pending.push({ resolve }));
		await device.stopRx();
		expect(callback).toHaveBeenCalledTimes(2);
		await device.startRx(callback);
		pending.shift().resolve({ status: 'ok', data: view(bytes.slice(0, 1024)) });
		await flush();
		expect([...callback.mock.lastCall[0]]).toEqual([...new AirspyIqConverter(12).process(view(bytes.slice(0, 1024)))]);
		await device.stopRx();
	});
	it('cancels blocked reads by closing/reopening USB after a bounded stop wait', async () => {
		vi.useFakeTimers();
		const { device, usb } = await connected();
		usb.controlTransferOut.mockResolvedValue({ status: 'ok', bytesWritten: 0 });
		const callback = vi.fn();
		await device.startRx(callback);
		const stopping = device.stopRx();
		await vi.advanceTimersByTimeAsync(1000);
		await stopping;
		expect(usb.close).toHaveBeenCalledOnce();
		expect(usb.open).toHaveBeenCalledTimes(2);
		expect(callback).not.toHaveBeenCalled();
	});
	it('fails before streaming if packed format cannot be disabled', async () => {
		const { device, usb } = await connected();
		usb.controlTransferIn.mockResolvedValueOnce({ status: 'stall' });
		await expect(device.startRx(vi.fn())).rejects.toThrow('vendor IN failed (req=26)');
		expect(usb.transferIn).not.toHaveBeenCalled();
	});
});
