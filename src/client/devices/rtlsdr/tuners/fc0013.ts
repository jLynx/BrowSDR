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

import type { RtlCom } from '../usb';

// ── FC0013 Tuner ─────────────────────────────────────────────────
// Very similar to FC0012 but different init regs, VHF tracking, and gain table.
// Source: tuner_fc0013.c (Hans-Frieder Vogt / Steve Markgraf / GPL-2.0)
export const FC0013_I2C_ADDR = 0xc6;

export const FC0013_BANDS: Array<[number, number, number, number]> = [
	[37084000, 96, 0x82, 0x00],
	[55625000, 64, 0x02, 0x02],
	[74167000, 48, 0x42, 0x00],
	[111250000, 32, 0x82, 0x02],
	[148334000, 24, 0x22, 0x00],
	[222500000, 16, 0x42, 0x02],
	[296667000, 12, 0x12, 0x00],
	[445000000, 8, 0x22, 0x02],
	[593334000, 6, 0x0a, 0x00],
	[950000000, 4, 0x12, 0x02],
	[Infinity, 2, 0x0a, 0x02],
];

// [gain_tenth_dB, register_value] — from fc0013_lna_gains[]
export const FC0013_LNA_GAINS: Array<[number, number]> = [
	[-99, 0x02],
	[-73, 0x03],
	[-65, 0x05],
	[-63, 0x04],
	[-63, 0x00],
	[-60, 0x07],
	[-58, 0x01],
	[-54, 0x06],
	[58, 0x0f],
	[61, 0x0e],
	[63, 0x0d],
	[65, 0x0c],
	[67, 0x0b],
	[68, 0x0a],
	[70, 0x09],
	[71, 0x08],
	[179, 0x17],
	[181, 0x16],
	[182, 0x15],
	[184, 0x14],
	[186, 0x13],
	[188, 0x12],
	[191, 0x11],
	[197, 0x10],
];

export class FC0013 {
	private com: RtlCom;
	private xtalFreq: number;

	constructor(com: RtlCom, xtalFreq: number) {
		this.com = com;
		this.xtalFreq = xtalFreq;
	}

	async init(): Promise<void> {
		// Init register table from tuner_fc0013.c fc0013_init()
		const initRegs: Array<[number, number]> = [
			[0x01, 0x09],
			[0x02, 0x16],
			[0x03, 0x00],
			[0x04, 0x00],
			[0x05, 0x17],
			[0x06, 0x02],
			[0x07, 0x2a], // 0x0a|0x20 for 28.8MHz xtal
			[0x08, 0xff],
			[0x09, 0x6e],
			[0x0a, 0xb8],
			[0x0b, 0x82],
			[0x0c, 0xfe],
			[0x0d, 0x01],
			[0x0e, 0x00],
			[0x0f, 0x00],
			[0x10, 0x00],
			[0x11, 0x00],
			[0x12, 0x00],
			[0x13, 0x00],
			[0x14, 0x50],
			[0x15, 0x01],
		];
		for (const [reg, val] of initRegs) {
			await this.com.writeI2CReg(FC0013_I2C_ADDR, reg, val);
		}
	}

	async setFrequency(freq: number): Promise<number> {
		const freqMhz = freq / 1e6;

		// VHF tracking filter
		await this.setVhfTrack(freq);

		// Band / VHF-UHF-GPS filter selection
		const reg07 = await this.com.readI2CReg(FC0013_I2C_ADDR, 0x07);
		const reg14 = await this.com.readI2CReg(FC0013_I2C_ADDR, 0x14);
		if (freq < 300000000) {
			// VHF: enable VHF filter, disable UHF+GPS
			await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x07, reg07 | 0x10);
			await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x14, reg14 & 0x1f);
		} else if (freq <= 862000000) {
			// UHF
			await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x07, reg07 & 0xef);
			await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x14, (reg14 & 0x1f) | 0x40);
		} else {
			// GPS
			await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x07, reg07 & 0xef);
			await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x14, (reg14 & 0x1f) | 0x20);
		}

		// Find multiplier and band regs
		let multi = 2,
			reg5val = 0x0a,
			reg6val = 0x02;
		for (const [maxFreq, m, r5, r6] of FC0013_BANDS) {
			if (freq < maxFreq) {
				multi = m;
				reg5val = r5;
				reg6val = r6;
				break;
			}
		}

		const xdiv2 = this.xtalFreq / 2;
		const fvco = freq * multi;

		let xdiv = Math.floor(fvco / xdiv2);
		if (fvco - xdiv * xdiv2 >= xdiv2 / 2) xdiv++;

		let pm = Math.floor(xdiv / 8);
		let am = xdiv - 8 * pm;
		if (am < 2) {
			am += 8;
			pm--;
		}
		if (pm > 31) {
			am = am + 8 * (pm - 31);
			pm = 31;
		}
		if (am > 15 || pm < 0x0b) {
			console.warn(`FC0013: no valid PLL for ${(freq / 1e6).toFixed(3)} MHz`);
		}

		// VCO high select
		if (fvco >= 3060000000) reg6val |= 0x08;
		// Clock out fix
		reg6val |= 0x20;

		// Fractional XIN
		const fRem = fvco - Math.floor(fvco / xdiv2) * xdiv2;
		let xin = Math.floor(((fRem / 1000) * 32768) / (xdiv2 / 1000));
		if (xin >= 16384) xin += 32768;
		xin &= 0xffff;

		// Write PLL regs 1-6
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x01, am);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x02, pm);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x03, (xin >> 8) & 0xff);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x04, xin & 0xff);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x05, reg5val | 0x07); // Realtek demod fix
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x06, reg6val | 0x80); // 8 MHz BW

		// multi=64 requires extra bit in reg 0x11
		const reg11 = await this.com.readI2CReg(FC0013_I2C_ADDR, 0x11);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x11, multi === 64 ? reg11 | 0x04 : reg11 & 0xfb);

		// VCO calibration
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x0e, 0x80);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x0e, 0x00);

		// Allow VCO to settle before readback
		await new Promise((r) => setTimeout(r, 5));
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x0e, 0x00);

		// VCO re-calibration if out of range
		try {
			const vcoCal = await this.com.readI2CReg(FC0013_I2C_ADDR, 0x0e);
			const vcoTmp = vcoCal & 0x3f;
			const highVco = fvco >= 3060000000;
			if (highVco ? vcoTmp > 0x3c : vcoTmp < 0x02) {
				const newReg6 = highVco ? reg6val & ~0x08 : reg6val | 0x08;
				await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x06, newReg6 | 0x80);
				await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x0e, 0x80);
				await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x0e, 0x00);
			}
		} catch (_) {
			console.warn('FC0013: VCO calibration readback failed');
		}

		console.log(`FC0013: tuned to ${freqMhz.toFixed(3)} MHz (multi=${multi}, pm=${pm}, am=${am})`);
		return freq;
	}

	private async setVhfTrack(freq: number): Promise<void> {
		const cur = await this.com.readI2CReg(FC0013_I2C_ADDR, 0x1d);
		const base = cur & 0xe3;
		let bits: number;
		if (freq <= 177500000)
			bits = 0x1c; // track 7
		else if (freq <= 184500000)
			bits = 0x18; // track 6
		else if (freq <= 191500000)
			bits = 0x14; // track 5
		else if (freq <= 198500000)
			bits = 0x10; // track 4
		else if (freq <= 205500000)
			bits = 0x0c; // track 3
		else if (freq <= 219500000)
			bits = 0x08; // track 2
		else if (freq < 300000000)
			bits = 0x04; // track 1
		else bits = 0x1c; // UHF/GPS
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x1d, base | bits);
	}

	async setAutoGain(): Promise<void> {
		const cur = await this.com.readI2CReg(FC0013_I2C_ADDR, 0x0d);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x0d, cur & ~0x08);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x13, 0x0a); // fixed IF gain
	}

	getGains(): number[] {
		return FC0013_LNA_GAINS.map((g) => g[0]);
	}

	async setManualGain(gainIdx: number): Promise<void> {
		// Receive slider index
		const index = Math.max(0, Math.min(gainIdx, FC0013_LNA_GAINS.length - 1));
		const bestReg = FC0013_LNA_GAINS[index][1];

		// Enable manual gain mode
		const cur = await this.com.readI2CReg(FC0013_I2C_ADDR, 0x0d);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x0d, cur | 0x08);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x13, 0x0a); // fixed IF gain
		// Write LNA gain bits into reg 0x14[4:0]
		const reg14 = await this.com.readI2CReg(FC0013_I2C_ADDR, 0x14);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x14, (reg14 & 0xe0) | bestReg);
	}

	async close(): Promise<void> {
		// No specific shutdown for FC0013
	}
}
