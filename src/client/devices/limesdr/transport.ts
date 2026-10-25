import { errorMessage } from '@/platform/errors';
/*
LimeSDR USB WebUSB driver for BrowSDR
Copyright (c) 2026, jLynx <https://github.com/jLynx>

Based on LimeSuite (Apache 2.0) https://github.com/myriadrf/LimeSuite

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

import {
	CMD_GET_INFO,
	CMD_LMS7002_RST,
	CMD_LMS7002_WR,
	CMD_LMS7002_RD,
	CMD_USB_FIFO_RST,
	CMD_BRDSPI_WR,
	CMD_BRDSPI_RD,
	STATUS_UNKNOWN_CMD,
	LimeSDRCommandError,
	EP_CTRL_OUT,
	EP_CTRL_IN_NUM,
	REG_RESET,
	setBits,
} from './protocol';
import type { SdrDeviceInfo } from '@/radio/types';

export abstract class LimeSDRTransport {
	abstract close(): Promise<void>;
	protected dev!: USBDevice;
	protected commandQueue: Promise<void> = Promise.resolve();
	protected rxRunning: Array<Promise<void>> | null = null;
	protected regCache = new Map<number, number>();
	protected currentSampleRate = 10e6;
	protected currentFrequency = 100e6;
	protected rxChannel = 0;

	// ── USB Communication ───────────────────────────────────────

	async open(device: USBDevice): Promise<void> {
		this.dev = device;
		try {
			await this.dev.open();
			await this.dev.selectConfiguration(1);
			await this.dev.claimInterface(0);
		} catch (error) {
			await this.close();
			if (error instanceof Error && /access denied/i.test(errorMessage(error))) {
				throw new Error(
					'LimeSDR: USB access denied. On Windows, this device must use WinUSB, not the Cypress CYUSB3 driver. ' +
						'Close other SDR applications or browser connections, check the device driver, then reconnect.',
					{ cause: error },
				);
			}
			throw error;
		}

		// Log available endpoints for debugging
		const iface = this.dev.configuration?.interfaces[0];
		if (iface) {
			const eps = iface.alternate.endpoints;
			console.log(`LimeSDR USB endpoints (${eps.length}):`);
			for (const ep of eps) {
				console.log(`  EP${ep.endpointNumber} ${ep.direction} ${ep.type} pktSize=${ep.packetSize}`);
			}
		}
	}

	protected sendCommand(cmd: number, payload?: Uint8Array): Promise<Uint8Array> {
		const pkt = new Uint8Array(64);
		pkt[0] = cmd;
		if (payload) {
			const blockSize = cmd === CMD_LMS7002_WR || cmd === CMD_BRDSPI_WR ? 4 : cmd === CMD_LMS7002_RD || cmd === CMD_BRDSPI_RD ? 2 : 1;
			const maxPayloadSize = cmd === CMD_LMS7002_RD || cmd === CMD_BRDSPI_RD ? 28 : 56;
			if (payload.length > maxPayloadSize || payload.length % blockSize !== 0) {
				return Promise.reject(new Error(`LimeSDR: invalid payload for command 0x${cmd.toString(16)}`));
			}
			pkt[2] = payload.length / blockSize;
			pkt.set(payload, 8);
		}

		const command = this.commandQueue.then(async () => {
			// Board information and USB FIFO reset are handled by the FX3 firmware.
			const control = cmd === CMD_GET_INFO || cmd === CMD_USB_FIFO_RST;
			const sent = control
				? await this.dev.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0xc1, value: 0, index: 0 }, pkt)
				: await this.dev.transferOut(EP_CTRL_OUT, pkt);
			if (sent.status !== 'ok' || sent.bytesWritten !== pkt.length) {
				throw new Error(`LimeSDR: USB command write failed (status=${sent.status}, bytes=${sent.bytesWritten})`);
			}
			const response = await this.readCommandResponse(cmd, control);
			if (response[1] !== 1) {
				throw new LimeSDRCommandError(cmd, response[1]);
			}
			return response;
		});
		this.commandQueue = command.then(
			() => {},
			() => {},
		);
		return command;
	}

	private async readCommandResponse(cmd: number, control = false): Promise<Uint8Array> {
		// A page reload can abandon a control read, leaving its reply in the FX3.
		// Only initialization's reset may discard old replies; register reads must
		// still fail on mismatches rather than accidentally accepting stale data.
		const attempts = cmd === CMD_LMS7002_RST ? 8 : 1;
		for (let attempt = 0; attempt < attempts; attempt++) {
			const result = control
				? await this.dev.controlTransferIn({ requestType: 'vendor', recipient: 'device', request: 0xc0, value: 0, index: 0 }, 64)
				: await this.dev.transferIn(EP_CTRL_IN_NUM, 64);
			if (result.status !== 'ok' || result.data?.byteLength !== 64)
				throw new Error(`LimeSDR: USB command response failed (status=${result.status}, bytes=${result.data?.byteLength ?? 0})`);
			const response = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
			if (response[0] === cmd) return response;
			if (attempt === attempts - 1)
				throw new Error(`LimeSDR: unexpected command response 0x${response[0].toString(16)} (expected 0x${cmd.toString(16)})`);
			console.warn(`LimeSDR: discarding stale command response 0x${response[0].toString(16)} during initialization`);
		}
		throw new Error('LimeSDR: control response recovery exhausted');
	}

	// ── LMS7002M SPI Registers ──────────────────────────────────

	async writeLMS7002(addr: number, value: number): Promise<void> {
		const data = new Uint8Array(4);
		data[0] = (addr >> 8) & 0x7f;
		data[1] = addr & 0xff;
		data[2] = (value >> 8) & 0xff;
		data[3] = value & 0xff;
		await this.sendCommand(CMD_LMS7002_WR, data);
		this.cacheRegister(addr, value);
	}

	async readLMS7002(addr: number): Promise<number> {
		const data = new Uint8Array(2);
		data[0] = (addr >> 8) & 0x7f; // No write flag
		data[1] = addr & 0xff;
		const resp = await this.sendCommand(CMD_LMS7002_RD, data);
		const value = (resp[8 + 2] << 8) | resp[8 + 3];
		this.cacheRegister(addr, value);
		return value;
	}

	async writeLMS7002Batch(pairs: Array<[number, number]>): Promise<void> {
		const maxPerPacket = 14; // 56 bytes / 4 bytes per register
		for (let offset = 0; offset < pairs.length; offset += maxPerPacket) {
			const chunk = pairs.slice(offset, offset + maxPerPacket);
			const data = new Uint8Array(chunk.length * 4);
			for (let i = 0; i < chunk.length; i++) {
				const [addr, value] = chunk[i];
				data[i * 4] = (addr >> 8) & 0x7f;
				data[i * 4 + 1] = addr & 0xff;
				data[i * 4 + 2] = (value >> 8) & 0xff;
				data[i * 4 + 3] = value & 0xff;
			}
			await this.sendCommand(CMD_LMS7002_WR, data);
			for (const [addr, value] of chunk) this.cacheRegister(addr, value);
		}
	}

	protected cacheRegister(addr: number, value: number): void {
		if (addr === REG_RESET && ((this.regCache.get(addr) ?? 0) & 3) !== (value & 3)) {
			for (const cachedAddress of this.regCache.keys()) {
				if (cachedAddress >= 0x0100) this.regCache.delete(cachedAddress);
			}
		}
		this.regCache.set(addr, value);
	}

	protected async modifyReg(addr: number, msb: number, lsb: number, value: number): Promise<void> {
		let reg = this.regCache.get(addr);
		if (reg === undefined) reg = await this.readLMS7002(addr);
		const updated = setBits(reg, msb, lsb, value);
		if (updated !== reg) await this.writeLMS7002(addr, updated);
	}

	protected async resetLogicRegisters(): Promise<void> {
		const reset = await this.readLMS7002(REG_RESET);
		await this.writeLMS7002(REG_RESET, reset & 0x55ff);
		await this.writeLMS7002(REG_RESET, reset | 0xff00);
	}

	protected async resetStreamBuffers(): Promise<void> {
		try {
			await this.sendCommand(CMD_USB_FIFO_RST, new Uint8Array([0]));
		} catch (error) {
			if (!(error instanceof LimeSDRCommandError) || error.command !== CMD_USB_FIFO_RST || error.status !== STATUS_UNKNOWN_CMD) {
				throw error;
			}
			console.warn('LimeSDR: firmware does not support USB FIFO reset; continuing with FPGA stream reset');
		}
	}

	// ── FPGA SPI Registers ──────────────────────────────────────

	async writeFPGA(addr: number, value: number): Promise<void> {
		const data = new Uint8Array(4);
		data[0] = (addr >> 8) & 0xff;
		data[1] = addr & 0xff;
		data[2] = (value >> 8) & 0xff;
		data[3] = value & 0xff;
		await this.sendCommand(CMD_BRDSPI_WR, data);
	}

	async readFPGA(addr: number): Promise<number> {
		const data = new Uint8Array(2);
		data[0] = (addr >> 8) & 0xff;
		data[1] = addr & 0xff;
		const resp = await this.sendCommand(CMD_BRDSPI_RD, data);
		return (resp[8 + 2] << 8) | resp[8 + 3];
	}

	// ── Device Info ─────────────────────────────────────────────

	async getDeviceInfo(): Promise<SdrDeviceInfo> {
		const resp = await this.sendCommand(CMD_GET_INFO);
		const fw = resp[8 + 0];
		const device = resp[8 + 1];
		const proto = resp[8 + 2];
		const hw = resp[8 + 3];
		const serialBytes = resp.slice(8 + 10, 8 + 18);
		const serial = Array.from(serialBytes)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

		// Read the same four identification registers as LimeSuite GetFPGAInfo.
		const fpga = await this.sendCommand(CMD_BRDSPI_RD, new Uint8Array([0, 0, 0, 1, 0, 2, 0, 3]));
		const target = (fpga[10] << 8) | fpga[11];
		const version = (fpga[14] << 8) | fpga[15];
		const revision = (fpga[18] << 8) | fpga[19];
		const info: SdrDeviceInfo = {
			name: limeDeviceName(device),
			serial,
			firmware: String(fw),
			hardware: device === 14 ? `1.${hw}` : String(hw),
			protocol: String(proto),
			expansion: LIME_EXPANSION_NAMES[resp[12]] ?? `Unknown (type=${resp[12]})`,
			gateware: `${version}.${revision}`,
			gatewareTarget: limeDeviceName(target),
			gatewareHardware: target === 14 ? `1.${fpga[23] & 0x7f}` : String(fpga[23] & 0x7f),
			usbSerial: this.dev.serialNumber || undefined,
		};
		console.log(
			`${info.name}: FW=${fw}, HW=${info.hardware}, Proto=${proto}, Serial=${serial}, Gateware=${info.gateware}, Target=${info.gatewareTarget}, FPGA HW=${info.gatewareHardware}, Expansion=${info.expansion}, USB Serial=${info.usbSerial ?? 'unavailable'}`,
		);
		return info;
	}
}

// LMSBoards.h protocol IDs; shared by FX3 and FPGA identification responses.
const LIME_DEVICE_NAMES = [
	'Unknown',
	'EVB6',
	'DigiGreen',
	'DigiRed',
	'EVB7',
	'ZIPPER',
	'Socket Board',
	'EVB7_v2',
	'Stream',
	'Novena',
	'DataSpark',
	'RF-Spark',
	'LMS6002-USB Stick',
	'RF-ESpark',
	'LimeSDR-USB',
	'LimeSDR-PCIe',
	'LimeSDR-QPCIe',
	'LimeSDR-Mini',
	'uStream',
	'LimeSDR SONY PA',
	'LimeSDR-USB SP',
	'LMS7002M Ultimate EVB',
	'LimeNET-Micro',
	'LimeSDR-Core',
	'LimeSDR-Core-HE',
	'LimeSDR-Mini v2',
];
const LIME_EXPANSION_NAMES = [
	'Unknown',
	'Unsupported',
	'Not available',
	'Myriad1',
	'Myriad2',
	'Novena',
	'HPM1000',
	'Myriad7',
	'HMP7',
	'Myriad7 Novena',
];

function limeDeviceName(id: number): string {
	return LIME_DEVICE_NAMES[id] ?? `Unknown (type=${id})`;
}
