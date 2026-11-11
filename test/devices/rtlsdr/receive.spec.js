import { afterEach, describe, expect, it, vi } from 'vitest';
import { RtlSdrDevice } from '@/devices/rtlsdr/device';
import { RtlCom } from '@/devices/rtlsdr/usb';
import { IqCapture } from '@/worker/recording/iq-capture';

afterEach(() => vi.restoreAllMocks());

async function flush() {
	for (let i = 0; i < 100; i++) await Promise.resolve();
}

function radio(rate = 2048000, conjugate = false) {
	const pending = [];
	const device = new RtlSdrDevice();
	device.sampleRate = rate;
	device.conjugateIq = conjugate;
	device.com = {
		writeReg: vi.fn().mockResolvedValue(undefined),
		readBulk: vi.fn((length) => new Promise((resolve, reject) => pending.push({ length, resolve, reject }))),
	};
	return {
		device,
		pending,
		async stop() {
			const stopping = device.stopRx();
			pending.splice(0).forEach(({ resolve }) => resolve(new ArrayBuffer(0)));
			await stopping;
		},
	};
}

describe('RTL-SDR receive continuity', () => {
	it('records continuous IQ through a simulated 128ms worker stall', async () => {
		const { device, pending, stop } = radio();
		const capture = new IqCapture();
		const recording = capture.start(2048000, 0.128);
		await device.startRx((bytes) => capture.push(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
		let missingSamples = 0;
		const expected = [];
		// USB continues completing 8ms reads while worker callbacks cannot run.
		// Four reads run out after 32ms; the prequeued reads must span the stall.
		for (let tick = 0; tick < 16; tick++) {
			const request = pending.shift();
			if (!request) {
				missingSamples += 16384;
				continue;
			}
			const bytes = new Uint8Array(request.length).fill(128 + tick);
			expected.push(...new Int8Array(request.length).fill(tick));
			request.resolve(bytes.buffer);
		}
		await flush();
		expect(missingSamples).toBe(0);
		expect([...(await recording)]).toEqual(expected);
		await stop();
	});

	it('preserves submission order when USB completions arrive out of order and queues before callbacks', async () => {
		const { device, pending, stop } = radio();
		const queuedBeforeDelivery = [];
		const callback = vi.fn(() => queuedBeforeDelivery.push(device.com.readBulk.mock.calls.length));
		await device.startRx(callback);
		const first = pending.shift(),
			second = pending.shift();
		second.resolve(Uint8Array.of(131, 132).buffer);
		await flush();
		expect(callback).not.toHaveBeenCalled();
		first.resolve(Uint8Array.of(129, 130).buffer);
		await flush();
		expect(callback.mock.calls.map(([bytes]) => [...new Int8Array(bytes.buffer)])).toEqual([
			[1, 2],
			[3, 4],
		]);
		expect(queuedBeforeDelivery).toEqual([33, 34]);
		await stop();
	});

	it.each([250000, 1024000, 2048000, 3200000])('retains short, aligned reads and bounded stall coverage at %s SPS', async (rate) => {
		const { device, pending, stop } = radio(rate);
		await device.startRx(vi.fn());
		const bytes = pending[0].length;
		expect(bytes % 512).toBe(0);
		expect(bytes / (rate * 2)).toBeLessThanOrEqual(0.008);
		expect((pending.length * bytes) / (rate * 2)).toBeGreaterThanOrEqual(0.256);
		expect(pending.length).toBeLessThanOrEqual(64);
		await stop();
	});

	it('converts unsigned IQ, conjugates Q and discards reads from a stopped session', async () => {
		const { device, pending, stop } = radio(2048000, true);
		const callback = vi.fn();
		await device.startRx(callback);
		pending.shift().resolve(Uint8Array.of(130, 131, 0, 255).buffer);
		await flush();
		expect([...new Int8Array(callback.mock.lastCall[0].buffer)]).toEqual([2, -3, -128, -127]);
		await stop();
		expect(callback).toHaveBeenCalledOnce();
		await device.startRx(callback);
		pending.shift().resolve(Uint8Array.of(128, 128).buffer);
		await flush();
		expect([...new Int8Array(callback.mock.lastCall[0].buffer)]).toEqual([0, 0]);
		await stop();
	});

	it('handles a later read rejection without emitting subsequent IQ after the failure', async () => {
		const { device, pending, stop } = radio();
		const callback = vi.fn();
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		await device.startRx(callback);
		const first = pending.shift(),
			second = pending.shift();
		second.reject(new Error('USB transfer failed'));
		await flush();
		first.resolve(Uint8Array.of(128, 128).buffer);
		await flush();
		expect(error).toHaveBeenCalledWith('RTL-SDR: transfer error:', 'USB transfer failed');
		expect(callback).toHaveBeenCalledOnce();
		await stop();
	});

	it('copies only delivered USB bytes, including short reads with a nonzero DataView offset', async () => {
		const bytes = Uint8Array.of(9, 9, 128, 130, 9, 9);
		const usb = { transferIn: vi.fn().mockResolvedValue({ status: 'ok', data: new DataView(bytes.buffer, 2, 2) }) };
		expect([...new Uint8Array(await new RtlCom(usb).readBulk(32768))]).toEqual([128, 130]);
		usb.transferIn.mockResolvedValueOnce({ status: 'ok' });
		await expect(new RtlCom(usb).readBulk(32768)).rejects.toThrow('bulk read failed');
	});
});
