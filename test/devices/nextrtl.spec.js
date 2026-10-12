import { afterEach, describe, expect, it, vi } from 'vitest';
import { RtlSdrDevice } from '@/devices/rtlsdr/device';
import { FC0013 } from '@/devices/rtlsdr/tuners/fc0013';
import { isNextrtl, nextrtlCalibration, Nextrtl } from '@/devices/rtlsdr/nextrtl';
import { RtlCom } from '@/devices/rtlsdr/usb';
import { BLOCK, WRITE_FLAG } from '@/devices/rtlsdr/protocol';

afterEach(() => vi.restoreAllMocks());

function calibration(lo = 125012345) {
	const bytes = new Uint8Array(16);
	bytes.set([0x4e, 0x58, 0x43, 0x4c, 1]);
	new DataView(bytes.buffer).setUint32(5, lo, true);
	bytes[15] = -bytes.reduce((sum, byte) => sum + byte, 0) & 0xff;
	return bytes;
}

function board({ synth = false, record = calibration(), status = 0, manufacturer = 'zxkmm', product = 'nextrtl' } = {}) {
	const registers = new Map([
		['1536:198:0', 0xa3], // FC0013 probe
		['512:12289', 0x08], // unrelated output stays set
		['512:12292', 0xff], // GPIO direction
	]);
	const pointers = new Map();
	const operations = [];
	const usb = {
		manufacturerName: manufacturer,
		productName: product,
		serialNumber: 'NR01',
		open: vi.fn(),
		selectConfiguration: vi.fn(),
		claimInterface: vi.fn(),
		releaseInterface: vi.fn(),
		close: vi.fn(),
		controlTransferOut: vi.fn(async (setup, buffer) => {
			const block = setup.index & ~WRITE_FLAG;
			const bytes = new Uint8Array(buffer);
			operations.push({ block, address: setup.value, bytes: [...bytes] });
			if (block === BLOCK.I2C) {
				if (setup.value === 0xc0 && !synth) return { status: 'stall' };
				pointers.set(setup.value, bytes[0]);
				for (let index = 1; index < bytes.length; index++) {
					registers.set(`${block}:${setup.value}:${bytes[0] + index - 1}`, bytes[index]);
				}
			} else {
				registers.set(`${block}:${setup.value}`, bytes[0]);
			}
			return { status: 'ok' };
		}),
		controlTransferIn: vi.fn(async (setup, length) => {
			const bytes = new Uint8Array(length);
			const pointer = pointers.get(setup.value) ?? 0;
			if (setup.index === BLOCK.I2C && setup.value === 0xa0) {
				// EEPROM reads must bypass the tuner repeater.
				expect(registers.get('1:288')).toBe(0x10);
				bytes[0] = record[pointer - 0xf0] ?? 0;
				pointers.set(setup.value, pointer + 1);
			} else if (setup.index === BLOCK.I2C && setup.value === 0xc0 && pointer === 0) {
				bytes[0] = status;
			} else {
				const key = setup.index === BLOCK.I2C ? `${setup.index}:${setup.value}:${pointer}` : `${setup.index}:${setup.value}`;
				bytes[0] = registers.get(key) ?? 0;
			}
			return { status: 'ok', data: new DataView(bytes.buffer) };
		}),
	};
	return { usb, registers, operations };
}

async function openBoard(options) {
	const fixture = board(options);
	const receiver = new RtlSdrDevice();
	const tuning = vi.spyOn(FC0013.prototype, 'setFrequency');
	vi.spyOn(console, 'log').mockImplementation(() => {});
	await receiver.open(fixture.usb);
	return { ...fixture, receiver, tuning };
}

describe('nextrtl calibration and identification', () => {
	it('requires both exact board strings', () => {
		expect(isNextrtl(board().usb)).toBe(true);
		expect(isNextrtl(board({ manufacturer: 'Realtek' }).usb)).toBe(false);
		expect(isNextrtl(board({ product: 'nextrtl beta' }).usb)).toBe(false);
	});
	it('accepts checksummed calibration within the nominal oscillator range', () => {
		expect(nextrtlCalibration(calibration().buffer)).toBe(125012345);
		for (const lo of [124875000, 125125000]) expect(nextrtlCalibration(calibration(lo).buffer)).toBe(lo);
	});
	it('rejects truncated, corrupt, unsupported and out-of-range calibration', () => {
		const corrupt = calibration();
		corrupt[10] ^= 1;
		const version = calibration();
		version[4] = 2;
		version[15]--;
		const signature = calibration();
		signature[0]--;
		signature[15]++;
		for (const bytes of [corrupt, version, signature, calibration(124874999), calibration(125125001), new Uint8Array(8)]) {
			expect(nextrtlCalibration(bytes.buffer)).toBeNull();
		}
	});
});

describe('nextrtl WebUSB reception controls', () => {
	it('uses rev 1 calibration, switches at 30 MHz and turns off HF and LED on close', async () => {
		const { receiver, registers, tuning } = await openBoard();
		expect(await receiver.getInfo()).toEqual({ name: 'RTL-SDR (nextrtl / FC0013)', serial: 'NR01' });
		expect(receiver.gainControls).toContainEqual(expect.objectContaining({ name: 'L-band input', default: 0 }));
		await receiver.setFrequency(7100000);
		expect(tuning).toHaveBeenLastCalledWith(132112345);
		expect(registers.get('512:12289')).toBe(0x8c);
		await receiver.setGain('Bias-T', 1);
		expect(registers.get('512:12289')).toBe(0x8d);
		await receiver.setFrequency(30000000);
		expect(tuning).toHaveBeenLastCalledWith(30000000);
		expect(registers.get('512:12289')).toBe(0x0d);
		await receiver.setFrequency(10000000);
		await receiver.close();
		expect(registers.get('512:12289')).toBe(0x09);
		expect(registers.get('512:12292') & 0xc5).toBe(0);
		expect(registers.get('1:288')).toBe(0x10);
	});
	it('falls back to the nominal rev 1 oscillator for invalid calibration', async () => {
		const { receiver, tuning } = await openBoard({ record: new Uint8Array(16) });
		await receiver.setFrequency(10000000);
		expect(tuning).toHaveBeenLastCalledWith(135000000);
	});
	it('scales the HF oscillator with the corrected reference clock', async () => {
		const fixture = board();
		const tuner = new Nextrtl(new RtlCom(fixture.usb), 28800000 * 1.0001);
		const tuning = vi.spyOn(FC0013.prototype, 'setFrequency');
		vi.spyOn(console, 'log').mockImplementation(() => {});
		await tuner.init();
		expect(await tuner.setFrequency(7100000)).toBe(7100000);
		expect(tuning).toHaveBeenLastCalledWith(132124846);
	});
	it('configures rev 2 integer PLL/divider and enables CLK0 only in HF', async () => {
		const { receiver, operations, registers, tuning } = await openBoard({ synth: true });
		expect(operations).toContainEqual({ block: BLOCK.I2C, address: 0xc0, bytes: [26, 0, 1, 0, 11, 0, 0, 0, 0] });
		expect(operations).toContainEqual({ block: BLOCK.I2C, address: 0xc0, bytes: [42, 0, 1, 0, 1, 0, 0, 0, 0] });
		expect(operations.some((operation) => operation.address === 0xa0)).toBe(false);
		expect(registers.get('1536:192:3')).toBe(0xff);
		await receiver.setFrequency(10000000);
		expect(tuning).toHaveBeenLastCalledWith(134800000);
		expect(registers.get('1536:192:3')).toBe(0xfe);
		await receiver.setFrequency(106200000);
		expect(tuning).toHaveBeenLastCalledWith(106200000);
		expect(registers.get('1536:192:3')).toBe(0xff);
		await receiver.setFrequency(7100000);
		await receiver.close();
		expect(registers.get('1536:192:3')).toBe(0xff);
	});
	it('keeps the main input above 862 MHz, opts into L-band at 1 GHz and preserves gain bits', async () => {
		const { receiver, registers, tuning } = await openBoard();
		await receiver.setFrequency(900000000);
		expect(registers.get('1536:198:20') & 0xe0).toBe(0x40);
		await receiver.setFrequency(1575420000);
		await receiver.setGain('Tuner', 23);
		expect(registers.get('1536:198:20')).toBe(0x50);
		await receiver.setGain('L-band input', 1);
		expect(registers.get('1536:198:20')).toBe(0x30);
		await receiver.setFrequency(999999999);
		expect(registers.get('1536:198:20')).toBe(0x50);
		await receiver.setFrequency(1000000000);
		expect(registers.get('1536:198:20')).toBe(0x30);
		await receiver.setGain('L-band input', 0);
		expect(registers.get('1536:198:20')).toBe(0x50);
		tuning.mockClear();
		await receiver.setGains({ Tuner: 10, 'Bias-T': 0, 'L-band input': 0 });
		expect(tuning).not.toHaveBeenCalled();
	});
	it('leaves a generic FC0013 untouched and removes board controls when reopening it', async () => {
		const { receiver, tuning } = await openBoard();
		await receiver.close();
		const generic = board({ manufacturer: 'Realtek', product: 'RTL2838' });
		await receiver.open(generic.usb);
		await receiver.setFrequency(100000000);
		expect(tuning).toHaveBeenLastCalledWith(100000000);
		expect(receiver.gainControls.some((control) => control.name === 'L-band input')).toBe(false);
		expect(generic.operations.some((operation) => [0xa0, 0xc0].includes(operation.address))).toBe(false);
		expect(generic.registers.get('512:12289')).toBe(0x08);
	});
	it('closes the repeater after tuning fails and allows the next tune to succeed', async () => {
		const { receiver, registers, tuning } = await openBoard({ synth: true });
		tuning.mockRejectedValueOnce(new Error('tuner failed'));
		await expect(receiver.setFrequency(7100000)).rejects.toThrow('tuner failed');
		expect(registers.get('1:288')).toBe(0x10);
		await receiver.setFrequency(106200000);
		expect(tuning).toHaveBeenLastCalledWith(106200000);
		expect(registers.get('1536:192:3')).toBe(0xff);
	});
	it.each([0x80, 0x20])('rejects an unready/unlocked rev 2 synthesizer (status %i) and closes the repeater', async (status) => {
		const fixture = board({ synth: true, status });
		const receiver = new RtlSdrDevice();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		await expect(receiver.open(fixture.usb)).rejects.toThrow('nextrtl: synthesizer');
		expect(fixture.registers.get('1:288')).toBe(0x10);
		expect(fixture.registers.get('512:12289') & 0x84).toBe(0);
	});
});
