import { describe, expect, it, vi } from 'vitest';
import { RtlCom } from '@/devices/rtlsdr/usb';
import { BLOCK, WRITE_FLAG } from '@/devices/rtlsdr/protocol';

describe('RTL-SDR USB transport', () => {
	it('writes little-endian device registers with the correct block and write flag', async () => {
		const device = { controlTransferOut: vi.fn().mockResolvedValue({ status: 'ok' }) };
		await new RtlCom(device).writeReg(BLOCK.USB, 0x2158, 0x0200, 2);
		const [setup, buffer] = device.controlTransferOut.mock.calls[0];
		expect(setup).toEqual({ requestType: 'vendor', recipient: 'device', request: 0, value: 0x2158, index: BLOCK.USB | WRITE_FLAG });
		expect([...new Uint8Array(buffer)]).toEqual([0x00, 0x02]);
	});
	it('writes big-endian demodulator registers and follows with the synchronization read', async () => {
		const device = {
			controlTransferOut: vi.fn().mockResolvedValue({ status: 'ok' }),
			controlTransferIn: vi.fn().mockResolvedValue({ status: 'ok', data: new DataView(new ArrayBuffer(8)) }),
		};
		await new RtlCom(device).writeDemodReg(1, 0x9f, 0x1234, 2);
		const [setup, buffer] = device.controlTransferOut.mock.calls[0];
		expect(setup).toMatchObject({ value: 0x9f20, index: 1 | WRITE_FLAG });
		expect([...new Uint8Array(buffer)]).toEqual([0x12, 0x34]);
		expect(device.controlTransferIn).toHaveBeenCalledWith(expect.objectContaining({ value: 0x120, index: 0x0a }), 8);
	});
	it('selects an I2C register before reading its little-endian response', async () => {
		const device = {
			controlTransferOut: vi.fn().mockResolvedValue({ status: 'ok' }),
			controlTransferIn: vi.fn().mockResolvedValue({ status: 'ok', data: new DataView(Uint8Array.of(0x96, 0, 0, 0, 0, 0, 0, 0).buffer) }),
		};
		expect(await new RtlCom(device).readI2CReg(0x34, 0x00)).toBe(0x96);
		expect(device.controlTransferOut).toHaveBeenCalledWith(
			expect.objectContaining({ value: 0x34, index: BLOCK.I2C | WRITE_FLAG }),
			expect.any(ArrayBuffer),
		);
		expect(device.controlTransferIn).toHaveBeenCalledWith(expect.objectContaining({ value: 0x34, index: BLOCK.I2C }), 8);
	});
	it('reports failed USB reads and writes instead of continuing with invalid data', async () => {
		const device = {
			controlTransferOut: vi.fn().mockResolvedValue({ status: 'stall' }),
			controlTransferIn: vi.fn().mockResolvedValue({ status: 'stall' }),
		};
		const transport = new RtlCom(device);
		await expect(transport.readReg(BLOCK.USB, 0x2000, 1)).rejects.toThrow('RTL-SDR USB read failed');
		await expect(transport.writeReg(BLOCK.USB, 0x2000, 1, 1)).rejects.toThrow('RTL-SDR USB write failed');
	});
});
