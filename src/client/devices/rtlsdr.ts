/*
RTL-SDR WebUSB driver for BrowSDR
Copyright (c) 2026, jLynx <https://github.com/jLynx>

Based on rtlsdrjs by Sandeep Mistry (Apache 2.0)
  https://github.com/sandeepmistry/rtlsdrjs
Based on Google Radio Receiver by Jacobo Tarrío (Apache 2.0)
  https://github.com/nicholasgasior/nicholasgasior-chrome-apps-radio-receiver

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
	Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
	Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the
	documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import type { SdrDevice, SdrDeviceInfo, GainControl } from '../sdr-device';
import { registerDriver } from '../sdr-device';

// ── USB Protocol Constants ────────────────────────────────────────
const XTAL_FREQ = 28800000;
const IF_FREQ = 3570000;
const BYTES_PER_SAMPLE = 2;
const TRANSFER_BUFFER_SIZE = 16384;
const WRITE_FLAG = 0x10;

const BLOCK = {
	DEMOD: 0x000,
	USB: 0x100,
	SYS: 0x200,
	I2C: 0x600,
};

const REG = {
	SYSCTL: 0x2000,
	EPA_CTL: 0x2148,
	EPA_MAXPKT: 0x2158,
	DEMOD_CTL: 0x3000,
	DEMOD_CTL_1: 0x300b,
};

// ── R820T Tuner Constants ─────────────────────────────────────────
const R820T_I2C_ADDR = 0x34;
const R820T_CHECK_VAL = 0x69;
const R820T_INIT_REGS = [
	0x83, 0x32, 0x75, 0xc0, 0x40, 0xd6, 0x6c,
	0xf5, 0x63, 0x75, 0x68, 0x6c, 0x83, 0x80, 0x00,
	0x0f, 0x00, 0xc0, 0x30, 0x48, 0xcc, 0x60, 0x00,
	0x54, 0xae, 0x4a, 0xc0,
];

const MUX_CFGS: [number, number, number, number][] = [
	[0, 0x08, 0x02, 0xdf],
	[50, 0x08, 0x02, 0xbe],
	[55, 0x08, 0x02, 0x8b],
	[60, 0x08, 0x02, 0x7b],
	[65, 0x08, 0x02, 0x69],
	[70, 0x08, 0x02, 0x58],
	[75, 0x00, 0x02, 0x44],
	[90, 0x00, 0x02, 0x34],
	[110, 0x00, 0x02, 0x24],
	[140, 0x00, 0x02, 0x14],
	[180, 0x00, 0x02, 0x13],
	[250, 0x00, 0x02, 0x11],
	[280, 0x00, 0x02, 0x00],
	[310, 0x00, 0x41, 0x00],
	[588, 0x00, 0x40, 0x00],
];

const BIT_REVS = [
	0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe,
	0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf,
];

// ── Low-level USB communication layer ─────────────────────────────
class RtlCom {
	private dev: USBDevice;

	constructor(dev: USBDevice) {
		this.dev = dev;
	}

	async writeReg(block: number, reg: number, value: number, length: number): Promise<void> {
		const buf = this.numberToBuffer(value, length);
		await this.writeCtrlMsg(reg, block | WRITE_FLAG, buf);
	}

	async readReg(block: number, reg: number, length: number): Promise<number> {
		const buf = await this.readCtrlMsg(reg, block, length);
		return this.bufferToNumber(buf);
	}

	async writeRegBuffer(block: number, reg: number, buffer: ArrayBuffer): Promise<void> {
		await this.writeCtrlMsg(reg, block | WRITE_FLAG, buffer);
	}

	async readRegBuffer(block: number, reg: number, length: number): Promise<ArrayBuffer> {
		return this.readCtrlMsg(reg, block, length);
	}

	async readDemodReg(page: number, addr: number): Promise<number> {
		return this.readReg(page, (addr << 8) | 0x20, 1);
	}

	async writeDemodReg(page: number, addr: number, value: number, len: number): Promise<void> {
		const buf = this.numberToBuffer(value, len, true);
		await this.writeCtrlMsg((addr << 8) | 0x20, page | WRITE_FLAG, buf);
		await this.readDemodReg(0x0a, 0x01);
	}

	async openI2C(): Promise<void> {
		await this.writeDemodReg(1, 1, 0x18, 1);
	}

	async closeI2C(): Promise<void> {
		await this.writeDemodReg(1, 1, 0x10, 1);
	}

	async readI2CReg(addr: number, reg: number): Promise<number> {
		await this.writeRegBuffer(BLOCK.I2C, addr, new Uint8Array([reg]).buffer);
		return this.readReg(BLOCK.I2C, addr, 1);
	}

	async writeI2CReg(addr: number, reg: number, value: number): Promise<void> {
		await this.writeRegBuffer(BLOCK.I2C, addr, new Uint8Array([reg, value]).buffer);
	}

	async readI2CRegBuffer(addr: number, reg: number, len: number): Promise<ArrayBuffer> {
		await this.writeRegBuffer(BLOCK.I2C, addr, new Uint8Array([reg]).buffer);
		return this.readRegBuffer(BLOCK.I2C, addr, len);
	}

	async readBulk(length: number): Promise<ArrayBuffer> {
		const result = await this.dev.transferIn(1, length);
		if (result.status !== 'ok') throw new Error('RTL-SDR bulk read failed: ' + result.status);
		return new Uint8Array(result.data!.buffer).buffer as ArrayBuffer;
	}

	private async readCtrlMsg(value: number, index: number, length: number): Promise<ArrayBuffer> {
		const result = await this.dev.controlTransferIn({
			requestType: 'vendor',
			recipient: 'device',
			request: 0,
			value,
			index,
		}, Math.max(8, length));
		if (result.status !== 'ok') throw new Error('RTL-SDR USB read failed');
		return new Uint8Array(result.data!.buffer).slice(0, length).buffer as ArrayBuffer;
	}

	private async writeCtrlMsg(value: number, index: number, data: ArrayBuffer): Promise<void> {
		const result = await this.dev.controlTransferOut({
			requestType: 'vendor',
			recipient: 'device',
			request: 0,
			value,
			index,
		}, data);
		if (result.status !== 'ok') throw new Error('RTL-SDR USB write failed');
	}

	private bufferToNumber(buffer: ArrayBuffer): number {
		const dv = new DataView(buffer);
		if (buffer.byteLength === 1) return dv.getUint8(0);
		if (buffer.byteLength === 2) return dv.getUint16(0, true);
		if (buffer.byteLength === 4) return dv.getUint32(0, true);
		return 0;
	}

	private numberToBuffer(value: number, len: number, bigEndian = false): ArrayBuffer {
		const buffer = new ArrayBuffer(len);
		const dv = new DataView(buffer);
		if (len === 1) dv.setUint8(0, value);
		else if (len === 2) dv.setUint16(0, value, !bigEndian);
		else if (len === 4) dv.setUint32(0, value, !bigEndian);
		return buffer;
	}
}

// ── R820T Tuner ───────────────────────────────────────────────────
class R820T {
	private com: RtlCom;
	private xtalFreq: number;
	private shadowRegs!: Uint8Array;
	private hasPllLock = false;

	constructor(com: RtlCom, xtalFreq: number) {
		this.com = com;
		this.xtalFreq = xtalFreq;
	}

	static async check(com: RtlCom): Promise<boolean> {
		const val = await com.readI2CReg(R820T_I2C_ADDR, 0);
		return val === R820T_CHECK_VAL;
	}

	async init(): Promise<void> {
		this.shadowRegs = new Uint8Array(R820T_INIT_REGS);
		for (let i = 0; i < R820T_INIT_REGS.length; i++) {
			await this.com.writeI2CReg(R820T_I2C_ADDR, i + 5, R820T_INIT_REGS[i]);
		}
		await this.initElectronics();
	}

	async setFrequency(freq: number): Promise<number> {
		await this.setMux(freq);
		return this.setPll(freq);
	}

	async setAutoGain(): Promise<void> {
		await this.writeEach([
			[0x05, 0x00, 0x10],
			[0x07, 0x10, 0x10],
			[0x0c, 0x0b, 0x9f],
		]);
	}

	async setManualGain(gain: number): Promise<void> {
		let step: number;
		if (gain <= 15) {
			step = Math.round(1.36 + gain * (1.1118 + gain * (-0.0786 + gain * 0.0027)));
		} else {
			step = Math.round(1.2068 + gain * (0.6875 + gain * (-0.01011 + gain * 0.0001587)));
		}
		step = Math.max(0, Math.min(30, step));
		const lnaValue = Math.floor(step / 2);
		const mixerValue = Math.floor((step - 1) / 2);
		await this.writeEach([
			[0x05, 0x10, 0x10],
			[0x07, 0x00, 0x10],
			[0x0c, 0x08, 0x9f],
			[0x05, lnaValue, 0x0f],
			[0x07, mixerValue, 0x0f],
		]);
	}

	async close(): Promise<void> {
		await this.writeEach([
			[0x06, 0xb1, 0xff], [0x05, 0xb3, 0xff], [0x07, 0x3a, 0xff],
			[0x08, 0x40, 0xff], [0x09, 0xc0, 0xff], [0x0a, 0x36, 0xff],
			[0x0c, 0x35, 0xff], [0x0f, 0x68, 0xff], [0x11, 0x03, 0xff],
			[0x17, 0xf4, 0xff], [0x19, 0x0c, 0xff],
		]);
	}

	private async initElectronics(): Promise<void> {
		await this.writeEach([
			[0x0c, 0x00, 0x0f],
			[0x13, 49, 0x3f],
			[0x1d, 0x00, 0x38],
		]);
		const filterCap = await this.calibrateFilter(true);
		await this.writeEach([
			[0x0a, 0x10 | filterCap, 0x1f],
			[0x0b, 0x6b, 0xef],
			[0x07, 0x00, 0x80],
			[0x06, 0x10, 0x30],
			[0x1e, 0x40, 0x60],
			[0x05, 0x00, 0x80],
			[0x1f, 0x00, 0x80],
			[0x0f, 0x00, 0x80],
			[0x19, 0x60, 0x60],
			[0x1d, 0xe5, 0xc7],
			[0x1c, 0x24, 0xf8],
			[0x0d, 0x53, 0xff],
			[0x0e, 0x75, 0xff],
			[0x05, 0x00, 0x60],
			[0x06, 0x00, 0x08],
			[0x11, 0x38, 0x08],
			[0x17, 0x30, 0x30],
			[0x0a, 0x40, 0x60],
			[0x1d, 0x00, 0x38],
			[0x1c, 0x00, 0x04],
			[0x06, 0x00, 0x40],
			[0x1a, 0x30, 0x30],
			[0x1d, 0x18, 0x38],
			[0x1c, 0x24, 0x04],
			[0x1e, 0x0d, 0x1f],
			[0x1a, 0x20, 0x30],
		]);
	}

	private async calibrateFilter(firstTry: boolean): Promise<number> {
		await this.writeEach([
			[0x0b, 0x6b, 0x60],
			[0x0f, 0x04, 0x04],
			[0x10, 0x00, 0x03],
		]);
		await this.setPll(56000000);
		if (!this.hasPllLock) throw new Error('PLL not locked during filter calibration');
		await this.writeEach([
			[0x0b, 0x10, 0x10],
			[0x0b, 0x00, 0x10],
			[0x0f, 0x00, 0x04],
		]);
		const data = await this.readRegBuffer(0x00, 5);
		let filterCap = data[4] & 0x0f;
		if (filterCap === 0x0f) filterCap = 0;
		if (filterCap !== 0 && firstTry) return this.calibrateFilter(false);
		return filterCap;
	}

	private async setMux(freq: number): Promise<void> {
		const freqMhz = freq / 1000000;
		let i: number;
		for (i = 0; i < MUX_CFGS.length - 1; i++) {
			if (freqMhz < MUX_CFGS[i + 1][0]) break;
		}
		const cfg = MUX_CFGS[i];
		await this.writeEach([
			[0x17, cfg[1], 0x08],
			[0x1a, cfg[2], 0xc3],
			[0x1b, cfg[3], 0xff],
			[0x10, 0x00, 0x0b],
			[0x08, 0x00, 0x3f],
			[0x09, 0x00, 0x3f],
		]);
	}

	private async setPll(freq: number): Promise<number> {
		const pllRef = Math.floor(this.xtalFreq);
		await this.writeEach([
			[0x10, 0x00, 0x10],
			[0x1a, 0x00, 0x0c],
			[0x12, 0x80, 0xe0],
		]);
		let divNum = Math.min(6, Math.floor(Math.log(1770000000 / freq) / Math.LN2));
		const mixDiv = 1 << (divNum + 1);
		const data = await this.readRegBuffer(0x00, 5);
		const vcoFineTune = (data[4] & 0x30) >> 4;
		if (vcoFineTune > 2) --divNum;
		else if (vcoFineTune < 2) ++divNum;
		await this.writeRegMask(0x10, divNum << 5, 0xe0);

		const vcoFreq = freq * mixDiv;
		const nint = Math.floor(vcoFreq / (2 * pllRef));
		const vcoFra = vcoFreq % (2 * pllRef);

		if (nint > 63) { this.hasPllLock = false; return 0; }

		const ni = Math.floor((nint - 13) / 4);
		const si = (nint - 13) % 4;
		await this.writeEach([
			[0x14, ni + (si << 6), 0xff],
			[0x12, vcoFra === 0 ? 0x08 : 0x00, 0x08],
		]);
		const sdm = Math.min(65535, Math.floor(32768 * vcoFra / pllRef));
		await this.writeEach([
			[0x16, sdm >> 8, 0xff],
			[0x15, sdm & 0xff, 0xff],
		]);
		await this.getPllLock(true);
		await this.writeRegMask(0x1a, 0x08, 0x08);
		return 2 * pllRef * (nint + sdm / 65536) / mixDiv;
	}

	private async getPllLock(firstTry: boolean): Promise<void> {
		const data = await this.readRegBuffer(0x00, 3);
		if (data[2] & 0x40) { this.hasPllLock = true; return; }
		if (firstTry) {
			await this.writeRegMask(0x12, 0x60, 0xe0);
			return this.getPllLock(false);
		}
		this.hasPllLock = false;
	}

	private async readRegBuffer(addr: number, length: number): Promise<Uint8Array> {
		const buf = await this.com.readI2CRegBuffer(R820T_I2C_ADDR, addr, length);
		const arr = new Uint8Array(buf);
		// R820T returns bit-reversed data
		for (let i = 0; i < arr.length; i++) {
			const b = arr[i];
			arr[i] = (BIT_REVS[b & 0xf] << 4) | BIT_REVS[b >> 4];
		}
		return arr;
	}

	private async writeRegMask(addr: number, value: number, mask: number): Promise<void> {
		const rc = this.shadowRegs[addr - 5];
		const val = (rc & ~mask) | (value & mask);
		this.shadowRegs[addr - 5] = val;
		await this.com.writeI2CReg(R820T_I2C_ADDR, addr, val);
	}

	private async writeEach(cmds: [number, number, number][]): Promise<void> {
		for (const [addr, value, mask] of cmds) {
			await this.writeRegMask(addr, value, mask);
		}
	}
}

// ── RTL-SDR Device ────────────────────────────────────────────────
export class RtlSdrDevice implements SdrDevice {
	readonly deviceType = 'rtlsdr';
	readonly sampleRates = [
		250000, 1024000, 1536000, 1792000, 1920000,
		2048000, 2160000, 2400000, 2560000, 2880000, 3200000,
	];
	readonly sampleFormat = 'uint8' as const;
	readonly gainControls: GainControl[] = [
		{ name: 'Tuner Gain', min: 0, max: 50, step: 1, default: 20, type: 'slider' },
		{ name: 'Bias-T', min: 0, max: 1, step: 1, default: 0, type: 'checkbox' },
	];

	private dev!: USBDevice;
	private com!: RtlCom;
	private tuner!: R820T;
	private rxRunning: Promise<void>[] | null = null;
	private ppm = 0;

	async open(device: USBDevice): Promise<void> {
		this.dev = device;
		await device.open();
		await device.selectConfiguration(1);
		this.com = new RtlCom(device);

		// Initialize RTL2832U demodulator
		await this.com.writeReg(BLOCK.USB, REG.SYSCTL, 0x09, 1);
		await this.com.writeReg(BLOCK.USB, REG.EPA_MAXPKT, 0x0200, 2);
		await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0210, 2);

		await device.claimInterface(0);

		// Initialize demodulator registers
		await this.com.writeReg(BLOCK.SYS, REG.DEMOD_CTL_1, 0x22, 1);
		await this.com.writeReg(BLOCK.SYS, REG.DEMOD_CTL, 0xe8, 1);

		// Write demod register init sequence
		await this.com.writeDemodReg(1, 0x01, 0x14, 1);
		await this.com.writeDemodReg(1, 0x01, 0x10, 1);
		await this.com.writeDemodReg(1, 0x15, 0x00, 1);
		await this.com.writeDemodReg(1, 0x16, 0x0000, 2);
		await this.com.writeDemodReg(1, 0x16, 0x00, 1);
		await this.com.writeDemodReg(1, 0x17, 0x00, 1);
		await this.com.writeDemodReg(1, 0x18, 0x00, 1);
		await this.com.writeDemodReg(1, 0x19, 0x00, 1);
		await this.com.writeDemodReg(1, 0x1a, 0x00, 1);
		await this.com.writeDemodReg(1, 0x1b, 0x00, 1);
		await this.com.writeDemodReg(1, 0x1c, 0xca, 1);
		await this.com.writeDemodReg(1, 0x1d, 0xdc, 1);
		await this.com.writeDemodReg(1, 0x1e, 0xd7, 1);
		await this.com.writeDemodReg(1, 0x1f, 0xd8, 1);
		await this.com.writeDemodReg(1, 0x20, 0xe0, 1);
		await this.com.writeDemodReg(1, 0x21, 0xf2, 1);
		await this.com.writeDemodReg(1, 0x22, 0x0e, 1);
		await this.com.writeDemodReg(1, 0x23, 0x35, 1);
		await this.com.writeDemodReg(1, 0x24, 0x06, 1);
		await this.com.writeDemodReg(1, 0x25, 0x50, 1);
		await this.com.writeDemodReg(1, 0x26, 0x9c, 1);
		await this.com.writeDemodReg(1, 0x27, 0x0d, 1);
		await this.com.writeDemodReg(1, 0x28, 0x71, 1);
		await this.com.writeDemodReg(1, 0x29, 0x11, 1);
		await this.com.writeDemodReg(1, 0x2a, 0x14, 1);
		await this.com.writeDemodReg(1, 0x2b, 0x71, 1);
		await this.com.writeDemodReg(1, 0x2c, 0x74, 1);
		await this.com.writeDemodReg(1, 0x2d, 0x19, 1);
		await this.com.writeDemodReg(1, 0x2e, 0x41, 1);
		await this.com.writeDemodReg(1, 0x2f, 0xa5, 1);
		await this.com.writeDemodReg(0, 0x19, 0x05, 1);
		await this.com.writeDemodReg(1, 0x93, 0xf0, 1);
		await this.com.writeDemodReg(1, 0x94, 0x0f, 1);
		await this.com.writeDemodReg(1, 0x11, 0x00, 1);
		await this.com.writeDemodReg(1, 0x04, 0x00, 1);
		await this.com.writeDemodReg(0, 0x61, 0x60, 1);
		await this.com.writeDemodReg(0, 0x06, 0x80, 1);
		await this.com.writeDemodReg(1, 0xb1, 0x1b, 1);
		await this.com.writeDemodReg(0, 0x0d, 0x83, 1);

		// Detect and initialize R820T tuner
		const xtalFreq = Math.floor(XTAL_FREQ * (1 + this.ppm / 1000000));
		await this.com.openI2C();
		const found = await R820T.check(this.com);
		if (!found) {
			await this.com.closeI2C();
			throw new Error('RTL-SDR: Unsupported tuner chip. Only R820T/R820T2 is supported.');
		}
		this.tuner = new R820T(this.com, xtalFreq);

		// Set IF frequency offset
		const multiplier = -1 * Math.floor(IF_FREQ * (1 << 22) / xtalFreq);
		await this.com.writeDemodReg(1, 0xb1, 0x1a, 1);
		await this.com.writeDemodReg(0, 0x08, 0x4d, 1);
		await this.com.writeDemodReg(1, 0x19, (multiplier >> 16) & 0x3f, 1);
		await this.com.writeDemodReg(1, 0x1a, (multiplier >> 8) & 0xff, 1);
		await this.com.writeDemodReg(1, 0x1b, multiplier & 0xff, 1);
		await this.com.writeDemodReg(1, 0x15, 0x01, 1);

		await this.tuner.init();
		await this.tuner.setAutoGain();
		await this.com.closeI2C();
	}

	async close(): Promise<void> {
		await this.stopRx();
		try {
			await this.com.openI2C();
			await this.tuner.close();
			await this.com.closeI2C();
		} catch (_) { /* ignore */ }
		try {
			await (this.dev as any).releaseInterface(0);
		} catch (_) { /* ignore */ }
		try {
			await this.dev.close();
		} catch (_) { /* ignore */ }
	}

	async getInfo(): Promise<SdrDeviceInfo> {
		const name = 'RTL-SDR';
		const serial = this.dev.serialNumber || undefined;
		return { name, serial };
	}

	async setSampleRate(rate: number): Promise<void> {
		const xtalFreq = Math.floor(XTAL_FREQ * (1 + this.ppm / 1000000));
		let ratio = Math.floor(xtalFreq * (1 << 22) / rate);
		ratio &= 0x0ffffffc;
		const ppmOffset = -1 * Math.floor(this.ppm * (1 << 24) / 1000000);
		await this.com.writeDemodReg(1, 0x9f, (ratio >> 16) & 0xffff, 2);
		await this.com.writeDemodReg(1, 0xa1, ratio & 0xffff, 2);
		await this.com.writeDemodReg(1, 0x3e, (ppmOffset >> 8) & 0x3f, 1);
		await this.com.writeDemodReg(1, 0x3f, ppmOffset & 0xff, 1);
		// Reset demodulator
		await this.com.writeDemodReg(1, 0x01, 0x14, 1);
		await this.com.writeDemodReg(1, 0x01, 0x10, 1);
	}

	async setFrequency(freqHz: number): Promise<void> {
		await this.com.openI2C();
		await this.tuner.setFrequency(freqHz + IF_FREQ);
		await this.com.closeI2C();
	}

	async setGain(name: string, value: number): Promise<void> {
		if (name === 'Tuner Gain') {
			await this.com.openI2C();
			if (value <= 0) {
				await this.tuner.setAutoGain();
			} else {
				await this.tuner.setManualGain(value);
			}
			await this.com.closeI2C();
		} else if (name === 'Bias-T') {
			await this.setBiasTee(!!value);
		}
	}

	private async setBiasTee(enable: boolean): Promise<void> {
		// Set GPIO0 as output, then set its value
		// GPIO is controlled via SYS block register 0x3000 area
		const GPD = 0x3000; // GPIO direction register
		const GPO = 0x3001; // GPIO output value register
		const gpdVal = await this.com.readReg(BLOCK.SYS, GPD, 1);
		await this.com.writeReg(BLOCK.SYS, GPD, gpdVal | 0x01, 1); // GPIO0 = output
		const gpoVal = await this.com.readReg(BLOCK.SYS, GPO, 1);
		if (enable) {
			await this.com.writeReg(BLOCK.SYS, GPO, gpoVal | 0x01, 1);
		} else {
			await this.com.writeReg(BLOCK.SYS, GPO, gpoVal & ~0x01, 1);
		}
	}

	async startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		if (this.rxRunning) await this.stopRx();

		// Reset USB buffer
		await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0210, 2);
		await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0000, 2);

		// Start concurrent bulk transfer loops (same pattern as HackRF)
		const transfer = async (): Promise<void> => {
			await Promise.resolve();
			while (this.rxRunning) {
				try {
					const buf = await this.com.readBulk(TRANSFER_BUFFER_SIZE);
					// Convert uint8 IQ to int8 IQ by subtracting 128
					// This normalizes the format to match what the DSP pipeline expects
					const uint8Data = new Uint8Array(buf);
					const int8Data = new Int8Array(uint8Data.length);
					for (let i = 0; i < uint8Data.length; i++) {
						int8Data[i] = uint8Data[i] - 128;
					}
					callback(new Uint8Array(int8Data.buffer));
				} catch (e: unknown) {
					if (this.rxRunning) {
						const msg = e instanceof Error ? e.message : String(e);
						console.error('RTL-SDR: transfer error:', msg);
					}
					break;
				}
			}
		};
		this.rxRunning = Array.from({ length: 4 }, transfer);
	}

	async stopRx(): Promise<void> {
		if (this.rxRunning) {
			const promises = this.rxRunning;
			this.rxRunning = null;
			try { await Promise.allSettled(promises); } catch (_) { /* ignore */ }
		}
	}
}

// ── Register driver ───────────────────────────────────────────────
// Comprehensive list of known RTL2832U-based device VID/PIDs
const RTL_SDR_FILTERS: USBDeviceFilter[] = [
	// Realtek RTL2832U generic
	{ vendorId: 0x0bda, productId: 0x2832 },
	// Realtek RTL2832U OEM (RTL-SDR Blog, Nooelec, etc.)
	{ vendorId: 0x0bda, productId: 0x2838 },
	// DigitalNow Quad DVB-T PCI-E card
	{ vendorId: 0x0413, productId: 0x6680 },
	// Compro Videomate U620F
	{ vendorId: 0x185b, productId: 0x0620 },
	// Compro Videomate U650F
	{ vendorId: 0x185b, productId: 0x0650 },
	// Terratec Cinergy T Stick Black (rev 1)
	{ vendorId: 0x0ccd, productId: 0x00a9 },
	// Terratec NOXON DAB/DAB+ USB dongle (rev 1)
	{ vendorId: 0x0ccd, productId: 0x00b3 },
	// Terratec NOXON DAB Stick
	{ vendorId: 0x0ccd, productId: 0x00b4 },
	// Terratec NOXON DAB Stick (rev 2)
	{ vendorId: 0x0ccd, productId: 0x00b7 },
	// Terratec Cinergy T Stick RC (Rev.3)
	{ vendorId: 0x0ccd, productId: 0x00d3 },
	// Terratec T Stick PLUS
	{ vendorId: 0x0ccd, productId: 0x00d7 },
	// Terratec NOXON DAB/DAB+ USB dongle (rev 2)
	{ vendorId: 0x0ccd, productId: 0x00e0 },
	// Peak 102569AGPK
	{ vendorId: 0x1f4d, productId: 0xb803 },
	// Generic RTL2832U
	{ vendorId: 0x1b80, productId: 0xd3a4 },
	// Dexatek DK DVB-T Dongle
	{ vendorId: 0x1d19, productId: 0x1101 },
	// Dexatek Technology Ltd. DK mini DVB-T Dongle
	{ vendorId: 0x1d19, productId: 0x1102 },
	// Dexatek Technology Ltd. DK DVB-T Dongle (Logilink VG0002A)
	{ vendorId: 0x1d19, productId: 0x1103 },
	// Dexatek Technology Ltd. MSI DigiVox Micro HD
	{ vendorId: 0x1d19, productId: 0x1104 },
];

registerDriver({
	type: 'rtlsdr',
	name: 'RTL-SDR',
	filters: RTL_SDR_FILTERS,
	create: () => new RtlSdrDevice(),
});
