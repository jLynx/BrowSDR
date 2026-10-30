import { afterEach, describe, expect, it, vi } from 'vitest';
import { receiveTransferSize } from '@/radio/receive-transfer';
import { HackRF } from '@/devices/hackrf/usb';
import { HackRFDevice } from '@/devices/hackrf/device';
import { RtlSdrDevice } from '@/devices/rtlsdr/device';
import { RtlCom } from '@/devices/rtlsdr/usb';
import { AirspyDevice } from '@/devices/airspy';
import { AirspyHfDevice } from '@/devices/airspyhf';

afterEach(() => vi.restoreAllMocks());

function usbStream() {
	const pending = [];
	const usb = {
		controlTransferOut: vi.fn().mockResolvedValue({ status: 'ok' }),
		controlTransferIn: vi.fn(async (_, length) => ({ status: 'ok', data: new DataView(new ArrayBuffer(length)) })),
		clearHalt: vi.fn().mockResolvedValue(undefined),
		transferIn: vi.fn((endpoint, length) => new Promise((resolve) => pending.push({ endpoint, length, resolve }))),
	};
	return {
		usb,
		pending,
		async stop(receiver) {
			const stopping = receiver.stopRx();
			pending.splice(0).forEach(({ resolve }) => resolve({ status: 'ok', data: new DataView(new ArrayBuffer(8)) }));
			await stopping;
		},
	};
}

async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

function rtlReceiver(usb) {
	const receiver = new RtlSdrDevice();
	receiver.com = new RtlCom(usb);
	vi.spyOn(receiver.com, 'writeReg').mockResolvedValue(undefined);
	vi.spyOn(receiver.com, 'writeDemodReg').mockResolvedValue(undefined);
	return receiver;
}

describe('receive transfer latency for advertised device rates', () => {
	it.each([
		['HackRF', new HackRFDevice().sampleRates, 262144, 2],
		['RTL-SDR', new RtlSdrDevice().sampleRates, 65536, 2],
		['Airspy', new AirspyDevice().sampleRates, 262144, 4],
		['Airspy HF+', new AirspyHfDevice().sampleRates, 65536, 8],
	])('bounds %s reads to 8ms without splitting USB packets or IQ samples', (_, rates, maximum, sampleBytes) => {
		for (const rate of rates) {
			const bytes = receiveTransferSize(rate, maximum, sampleBytes);
			expect(bytes).toBeGreaterThanOrEqual(512);
			expect(bytes).toBeLessThanOrEqual(maximum);
			expect(bytes % 512).toBe(0);
			expect(bytes % sampleBytes).toBe(0);
			expect(bytes / sampleBytes / rate).toBeLessThanOrEqual(0.008);
		}
	});
});

describe('HackRF adaptive USB reads', () => {
	it.each([
		[2000000, 1, 31744],
		[4000000, 2, 31744],
		[10000000, 1, 159744],
		[20000000, 1, 262144],
	])('uses the accepted %i/%i sample rate for %i-byte reads', async (rate, divider, bytes) => {
		const fixture = usbStream();
		const receiver = new HackRF();
		receiver.device = fixture.usb;
		await receiver.setSampleRateManual(rate, divider);
		const callback = vi.fn();
		await receiver.startRx(callback);
		expect(fixture.usb.transferIn).toHaveBeenCalledTimes(8);
		expect(fixture.pending.every((read) => read.endpoint === 1 && read.length === bytes)).toBe(true);
		const buffer = new Uint8Array([99, 99, 20, 30, 40, 50, 99, 99]);
		fixture.pending.shift().resolve({ status: 'ok', data: new DataView(buffer.buffer, 2, 4) });
		await flush();
		expect([...callback.mock.lastCall[0]]).toEqual([20, 30, 40, 50]);
		expect(fixture.pending.at(-1).length).toBe(bytes);
		await fixture.stop(receiver);
		expect(callback).toHaveBeenCalledOnce();
	});
});

describe('RTL-SDR adaptive USB reads', () => {
	it.each([
		[250000, 3584],
		[1024000, 16384],
		[3200000, 51200],
	])('uses %i Sa/s for %i-byte reads and preserves unsigned IQ conversion', async (rate, bytes) => {
		const fixture = usbStream();
		const receiver = rtlReceiver(fixture.usb);
		await receiver.setSampleRate(rate);
		const callback = vi.fn();
		await receiver.startRx(callback);
		expect(fixture.pending).toHaveLength(4);
		expect(fixture.pending.every((read) => read.length === bytes)).toBe(true);
		fixture.pending.shift().resolve({ status: 'ok', data: new DataView(Uint8Array.of(128, 129, 0, 255).buffer) });
		await flush();
		expect([...new Int8Array(callback.mock.lastCall[0].buffer)]).toEqual([0, 1, -128, 127]);
		expect(fixture.pending.at(-1).length).toBe(bytes);
		await fixture.stop(receiver);
		expect(callback).toHaveBeenCalledOnce();
	});
	it('discards completions from the old read size after a stop and restart', async () => {
		const fixture = usbStream();
		const receiver = rtlReceiver(fixture.usb);
		const callback = vi.fn();
		await receiver.startRx(callback);
		const old = fixture.pending.splice(0);
		const stopped = receiver.stopRx();
		await receiver.startRx(callback);
		old.forEach(({ resolve }) => resolve({ status: 'ok', data: new DataView(new ArrayBuffer(8)) }));
		await stopped;
		expect(callback).not.toHaveBeenCalled();
		await fixture.stop(receiver);
	});
});

describe('Airspy adaptive ADC reads', () => {
	it.each([
		[2500000, 79872],
		[10000000, 262144],
	])('sizes %i IQ samples/s as two real ADC words per IQ pair (%i bytes)', async (rate, bytes) => {
		const fixture = usbStream();
		const receiver = new AirspyDevice();
		receiver.dev = fixture.usb;
		await receiver.setSampleRate(rate);
		const callback = vi.fn();
		await receiver.startRx(callback);
		expect(fixture.pending).toHaveLength(4);
		expect(fixture.pending.every((read) => read.length === bytes)).toBe(true);
		fixture.pending.shift().resolve({ status: 'ok', data: new DataView(Uint8Array.of(0, 8, 0, 8).buffer) });
		await flush();
		expect(callback.mock.lastCall[0]).toHaveLength(2);
		expect(fixture.pending.at(-1).length).toBe(bytes);
		await fixture.stop(receiver);
		expect(callback).toHaveBeenCalledOnce();
	});
});

describe('Airspy HF+ adaptive IQ reads', () => {
	it.each([
		[192000, 6144],
		[768000, 24576],
		[912000, 29184],
	])('sizes %i Sa/s for the signed 16-bit USB IQ path (%i bytes)', async (rate, bytes) => {
		const fixture = usbStream();
		const receiver = new AirspyHfDevice();
		receiver.dev = fixture.usb;
		await receiver.setSampleRate(rate);
		const callback = vi.fn();
		await receiver.startRx(callback);
		expect(fixture.pending).toHaveLength(4);
		expect(fixture.pending.every((read) => read.length === bytes)).toBe(true);
		const words = new Int16Array([99, 99, -16384, 16384, -32768, 32767, 99, 99]);
		fixture.pending.shift().resolve({ status: 'ok', data: new DataView(words.buffer, 4, 8) });
		await flush();
		expect([...new Int16Array(callback.mock.lastCall[0].buffer)]).toEqual([16384, -16384, 32767, -32768]);
		expect(fixture.pending.at(-1).length).toBe(bytes);
		await fixture.stop(receiver);
		expect(callback).toHaveBeenCalledOnce();
	});
});
