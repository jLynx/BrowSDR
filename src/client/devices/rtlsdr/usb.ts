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

import { WRITE_FLAG, BLOCK } from './protocol';

// ── Low-level USB communication layer ─────────────────────────────
export class RtlCom {
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
		// Dummy read of demod page 0x0a as sync barrier (matches librtlsdr).
		// This ensures the RTL2832U commits the write before we proceed.
		// Previously this stalled on FC0012 devices, but that crash was
		// actually caused by corrupted DEMOD_CTL from wrong GPIO addresses.
		try {
			await this.readDemodReg(0x0a, 0x01);
		} catch (_) {
			// Sync read failed — not critical, continue
		}
	}

	async openI2C(): Promise<void> {
		await this.writeDemodReg(1, 1, 0x18, 1);
	}

	async closeI2C(): Promise<void> {
		await this.writeDemodReg(1, 1, 0x10, 1);
	}

	async readI2CReg(addr: number, reg: number): Promise<number> {
		console.log(`RTL-SDR: I2C read addr=0x${addr.toString(16)} reg=0x${reg.toString(16)}`);
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
		return new Uint8Array(result.data.buffer).buffer as ArrayBuffer;
	}

	private async readCtrlMsg(value: number, index: number, length: number): Promise<ArrayBuffer> {
		const result = await this.dev.controlTransferIn(
			{
				requestType: 'vendor',
				recipient: 'device',
				request: 0,
				value,
				index,
			},
			Math.max(8, length),
		);
		if (result.status !== 'ok') {
			throw new Error(`RTL-SDR USB read failed: val=0x${value.toString(16)} idx=0x${index.toString(16)} status=${result.status}`);
		}
		return new Uint8Array(result.data.buffer).slice(0, length).buffer;
	}

	private async writeCtrlMsg(value: number, index: number, data: ArrayBuffer): Promise<void> {
		const result = await this.dev.controlTransferOut(
			{
				requestType: 'vendor',
				recipient: 'device',
				request: 0,
				value,
				index,
			},
			data,
		);
		if (result.status !== 'ok') {
			throw new Error(`RTL-SDR USB write failed: val=0x${value.toString(16)} idx=0x${index.toString(16)} status=${result.status}`);
		}
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

// R82xx tuner family: R820T, R820T2, R828D
// vcoPowerRef: 2 for R820T/R820T2, 1 for R828D (matches jtarrio/webrtlsdr)
