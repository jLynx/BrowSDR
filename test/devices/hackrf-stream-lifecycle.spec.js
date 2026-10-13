import { afterEach, describe, expect, it, vi } from 'vitest';
import { HackRF } from '@/devices/hackrf/usb';
import { HackRFDevice } from '@/devices/hackrf/device';

afterEach(() => vi.useRealTimers());

describe('HackRF receiver lifecycle', () => {
	it('returns firmware, IDs, API and supported hardware revision for device details', async () => {
		const device = new HackRFDevice();
		device.hackrf.readBoardId = vi.fn().mockResolvedValue(2);
		device.hackrf.readVersionString = vi.fn().mockResolvedValue('2024.02.1');
		device.hackrf.readPartIdSerialNo = vi.fn().mockResolvedValue({ partId: [0x12345678, 0x9abcdef0], serialNo: [0, 0, 0, 0x12345678] });
		device.hackrf.readApiVersion = vi.fn().mockResolvedValue([1, 0, 7]);
		device.hackrf.boardRevRead = vi.fn().mockResolvedValue(4);
		expect(await device.getInfo()).toMatchObject({
			firmware: '2024.02.1',
			boardId: 2,
			partId: '123456789abcdef0',
			serial: '00000000000000000000000012345678',
			apiVersion: '1.07',
			hardware: 'r9',
		});
		device.hackrf.boardRevRead.mockRejectedValueOnce(new Error('Unsupported'));
		expect(await device.getInfo()).not.toHaveProperty('hardware');
	});
	it('turns off the hardware before waiting for blocked USB reads and ignores late callbacks', async () => {
		const receiver = new HackRF();
		const pending = [];
		receiver.device = { transferIn: vi.fn(() => new Promise((resolve) => pending.push(resolve))) };
		receiver.setTransceiverMode = vi.fn(async (mode) => {
			if (mode === HackRF.HACKRF_TRANSCEIVER_MODE_OFF) {
				pending.splice(0).forEach((resolve) => resolve({ status: 'ok', data: new DataView(new ArrayBuffer(8)) }));
			}
		});
		const callback = vi.fn();
		await receiver.startRx(callback);
		expect(receiver.device.transferIn).toHaveBeenCalledTimes(8);
		await receiver.stopRx();
		expect(callback).not.toHaveBeenCalled();
		expect(receiver.rxRunning).toBeNull();
		await receiver.startRx(callback);
		pending.shift()({ status: 'ok', data: new DataView(new ArrayBuffer(8)) });
		await Promise.resolve();
		expect(callback).toHaveBeenCalledOnce();
		await receiver.stopRx();
	});
	it('cancels stalled bulk reads and reclaims USB before restarting', async () => {
		vi.useFakeTimers();
		const receiver = new HackRF();
		const pending = [];
		receiver.device = {
			transferIn: vi.fn(() => new Promise((resolve) => pending.push(resolve))),
			close: vi.fn(async () => pending.splice(0).forEach((resolve) => resolve({ status: 'ok', data: new DataView(new ArrayBuffer(8)) }))),
			open: vi.fn(async () => {}),
			selectConfiguration: vi.fn(async () => {}),
			claimInterface: vi.fn(async () => {}),
		};
		receiver.setTransceiverMode = vi.fn(async () => {});
		const callback = vi.fn();
		await receiver.startRx(callback);
		const stopping = receiver.stopRx();
		await vi.advanceTimersByTimeAsync(1000);
		await stopping;
		expect(receiver.device.close).toHaveBeenCalledOnce();
		expect(receiver.device.open).toHaveBeenCalledOnce();
		expect(receiver.device.claimInterface).toHaveBeenCalledWith(0);
		expect(callback).not.toHaveBeenCalled();
		await receiver.startRx(callback);
		pending.shift()({ status: 'ok', data: new DataView(new ArrayBuffer(8)) });
		await Promise.resolve();
		expect(callback).toHaveBeenCalledOnce();
		const stopped = receiver.stopRx();
		await vi.advanceTimersByTimeAsync(1000);
		await stopped;
	});
	it('reports startup failure when the radio opens but delivers no samples', async () => {
		vi.useFakeTimers();
		const device = new HackRFDevice();
		device.hackrf.startRx = vi.fn(async () => {});
		device.hackrf.stopRx = vi.fn(async () => {});
		const starting = device.startRx(vi.fn());
		const failure = expect(starting).rejects.toThrow('HackRF returned no USB samples');
		await vi.advanceTimersByTimeAsync(5000);
		await failure;
		expect(device.hackrf.stopRx).toHaveBeenCalledOnce();
	});
});
