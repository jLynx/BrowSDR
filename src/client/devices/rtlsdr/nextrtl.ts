import { FC0013, FC0013_I2C_ADDR } from './tuners/fc0013';
import { BLOCK, XTAL_FREQ } from './protocol';
import type { RtlCom } from './usb';

// Board protocol: https://github.com/zxkmm/rtl-sdr/blob/nextrtl/contrib/nextrtl/README.md
// USB/I2C addresses use the RTL2832U's eight-bit address convention.
const SYNTH_ADDR = 0xc0;
const NOMINAL_LO = 125000000;
const SYNTH_LO = 124800000;
const HF_MAX = 30000000;
const LBAND_MIN = 1000000000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function isNextrtl(device: USBDevice): boolean {
	return device.manufacturerName === 'zxkmm' && device.productName === 'nextrtl';
}

export function nextrtlCalibration(buffer: ArrayBuffer): number | null {
	const bytes = new Uint8Array(buffer);
	if (bytes.length !== 16 || bytes[0] !== 0x4e || bytes[1] !== 0x58 || bytes[2] !== 0x43 || bytes[3] !== 0x4c) return null;
	if (bytes[4] !== 1 || (bytes.reduce((sum, byte) => sum + byte, 0) & 0xff) !== 0) return null;
	const lo = new DataView(buffer).getUint32(5, true);
	return Math.abs(lo - NOMINAL_LO) <= 125000 ? lo : null;
}

export class Nextrtl extends FC0013 {
	private readonly transport: RtlCom;
	private readonly clockScale: number;
	private lo = NOMINAL_LO;
	private synthesized = false;
	private hf: boolean | null = null;
	private lband = false;
	private frequency: number | null = null;

	constructor(com: RtlCom, xtalFreq: number) {
		super(com, xtalFreq);
		this.transport = com;
		this.clockScale = xtalFreq / XTAL_FREQ;
	}

	// The caller holds the USB lock and keeps the tuner repeater enabled.
	override async init(): Promise<void> {
		await super.init();
		await this.transport.setGpioOutput(7);
		await this.transport.setGpioBit(7, false);
		await this.transport.setGpioOutput(2);
		await this.transport.setGpioBit(2, true);
		this.synthesized = await this.initializeSynthesizer();
		this.lo = this.synthesized ? SYNTH_LO : await this.readCalibration();
		await this.selectHf(false);
	}

	private async readCalibration(): Promise<number> {
		await this.transport.closeI2C();
		try {
			// The EEPROM is on the main bus, not behind the tuner repeater.
			await this.transport.writeRegBuffer(BLOCK.I2C, 0xa0, Uint8Array.of(0xf0).buffer);
			const bytes = new Uint8Array(16);
			for (let index = 0; index < bytes.length; index++) {
				bytes[index] = await this.transport.readReg(BLOCK.I2C, 0xa0, 1);
			}
			return nextrtlCalibration(bytes.buffer) ?? NOMINAL_LO;
		} catch {
			return NOMINAL_LO;
		} finally {
			await this.transport.openI2C();
		}
	}

	private async initializeSynthesizer(): Promise<boolean> {
		try {
			await this.transport.writeI2CReg(SYNTH_ADDR, 3, 0xff);
		} catch {
			// Rev 1 has a free-running oscillator and no synthesizer.
			return false;
		}
		// Retain detection even if configuration fails, so close disables CLK0.
		this.synthesized = true;
		for (let attempt = 0; ; attempt++) {
			if (!((await this.transport.readI2CReg(SYNTH_ADDR, 0)) & 0x80)) break;
			if (attempt === 10) throw new Error('nextrtl: synthesizer initialization timed out');
			await sleep(1);
		}
		for (let register = 16; register <= 23; register++) {
			await this.transport.writeI2CReg(SYNTH_ADDR, register, 0x80);
		}
		// Integer PLLA = reference * 26; multisynth 0 = PLLA / 6.
		await this.writeIntegerRatio(26, 26);
		await this.writeIntegerRatio(42, 6);
		await this.transport.writeI2CReg(SYNTH_ADDR, 15, 0x00);
		await this.transport.writeI2CReg(SYNTH_ADDR, 183, 0x52);
		const pllControl = await this.transport.readI2CReg(SYNTH_ADDR, 22);
		await this.transport.writeI2CReg(SYNTH_ADDR, 22, pllControl | 0x40);
		await this.transport.writeI2CReg(SYNTH_ADDR, 16, 0x4f);
		await this.transport.writeI2CReg(SYNTH_ADDR, 177, 0x20);
		await sleep(10);
		if ((await this.transport.readI2CReg(SYNTH_ADDR, 0)) & 0x20)
			throw new Error('nextrtl: synthesizer PLL is not locked; check the reference clock');
		return true;
	}

	private async writeIntegerRatio(register: number, ratio: number): Promise<void> {
		const p1 = 128 * ratio - 512;
		const bytes = Uint8Array.of(register, 0, 1, (p1 >> 16) & 3, (p1 >> 8) & 0xff, p1 & 0xff, 0, 0, 0);
		await this.transport.writeRegBuffer(BLOCK.I2C, SYNTH_ADDR, bytes.buffer);
	}

	private async selectHf(enabled: boolean): Promise<void> {
		if (this.hf === enabled) return;
		await this.transport.setGpioBit(7, enabled);
		if (this.synthesized) await this.transport.writeI2CReg(SYNTH_ADDR, 3, enabled ? 0xfe : 0xff);
		this.hf = enabled;
	}

	override async setFrequency(frequency: number): Promise<number> {
		const hf = frequency < HF_MAX;
		await this.selectHf(hf);
		await super.setFrequency(frequency + (hf ? Math.trunc(this.lo * this.clockScale) : 0));
		if (frequency >= 300000000) {
			// Keep the main SMA selected unless L-band is explicitly enabled.
			const gain = await this.transport.readI2CReg(FC0013_I2C_ADDR, 0x14);
			const input = this.lband && frequency >= LBAND_MIN ? 0x20 : 0x40;
			await this.transport.writeI2CReg(FC0013_I2C_ADDR, 0x14, (gain & 0x1f) | input);
		}
		this.frequency = frequency;
		return frequency;
	}

	async setLbandInput(enabled: boolean): Promise<void> {
		if (this.lband === enabled) return;
		this.lband = enabled;
		if (this.frequency !== null) await this.setFrequency(this.frequency);
	}

	override async close(): Promise<void> {
		try {
			await this.selectHf(false);
		} finally {
			await this.transport.setGpioBit(2, false);
		}
	}
}
