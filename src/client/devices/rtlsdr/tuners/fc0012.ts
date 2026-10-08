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

// ── FC0012 Tuner ──────────────────────────────────────────────────
export const FC0012_I2C_ADDR = 0xc6;
export const FC0012_CHECK_VAL = 0xa1;

// Frequency band table from librtlsdr tuner_fc0012.c:
// [maxFreqMHz, multiplier, reg5 (RF_OUTDIV_A), reg6 (RF_OUTDIV_B)]
export const FC0012_BANDS: Array<[number, number, number, number]> = [
	[37.084, 96, 0x82, 0x00],
	[55.625, 64, 0x82, 0x02],
	[74.167, 48, 0x42, 0x00],
	[111.25, 32, 0x42, 0x02],
	[148.334, 24, 0x22, 0x00],
	[222.5, 16, 0x22, 0x02],
	[296.667, 12, 0x12, 0x00],
	[445, 8, 0x12, 0x02],
	[593.334, 6, 0x0a, 0x00],
	[Infinity, 4, 0x0a, 0x02],
];

export const FC0012_GAINS = [-99, -40, 71, 179, 192];
export const FC0012_GAIN_REGS = [0x02, 0x00, 0x08, 0x17, 0x10];

export class FC0012 {
	private com: RtlCom;
	private xtalFreq: number;

	constructor(com: RtlCom, xtalFreq: number) {
		this.com = com;
		this.xtalFreq = xtalFreq;
	}

	async init(): Promise<void> {
		// FC0012 initialization register table (from librtlsdr tuner_fc0012.c)
		const initRegs: Array<[number, number]> = [
			[0x01, 0x05], // reg 1: RF_A
			[0x02, 0x10], // reg 2: RF_M
			[0x03, 0x00], // reg 3: RF_K high
			[0x04, 0x00], // reg 4: RF_K low
			[0x05, 0x0f], // reg 5: IF_M — set IF to 0
			[0x06, 0x00], // reg 6: control reg (LNA power, VCO speed, BW)
			[0x07, 0x20], // reg 7: bit5 = xtal 28.8MHz
			[0x08, 0xff], // reg 8: AGC clock divide by 256, gain 1/256, BW 1/8
			[0x09, 0x6e], // reg 9: disable loop-through, enable LO test buf
			[0x0a, 0xb8], // reg a: disable loop-through 2
			[0x0b, 0x82], // reg b: AGC
			[0x0c, 0xfe], // reg c: 0xfc | 0x02 for Realtek demod
			[0x0d, 0x02], // reg d: AGC/LNA force
			[0x0e, 0x00], // reg e: VCO calibration
			[0x0f, 0x00], // reg f
			[0x10, 0x00], // reg 10
			[0x11, 0x00], // reg 11
			[0x12, 0x1f], // reg 12: max gain
			[0x13, 0x08], // reg 13: LNA gain (mid value)
			[0x14, 0x00], // reg 14
			[0x15, 0x04], // reg 15: LNA compensation enabled
		];
		for (const [reg, val] of initRegs) {
			await this.com.writeI2CReg(FC0012_I2C_ADDR, reg, val);
		}
	}

	async setFrequency(freq: number): Promise<number> {
		const freqMhz = freq / 1e6;

		// Find the right band/multiplier/register values from librtlsdr table
		let multi = 4;
		let reg5val = 0x0a;
		let reg6val = 0x02;
		for (const [maxFreq, m, r5, r6] of FC0012_BANDS) {
			if (freqMhz < maxFreq) {
				multi = m;
				reg5val = r5;
				reg6val = r6;
				break;
			}
		}

		const f_vco = freq * multi;
		const xtal_freq_div_2 = this.xtalFreq / 2;

		// Calculate PLL divider: xdiv, then split into pm (coarse) and am (fine)
		// Match librtlsdr integer rounding: round up if remainder >= half
		let xdiv = Math.floor(f_vco / xtal_freq_div_2);
		if (f_vco - xdiv * xtal_freq_div_2 >= xtal_freq_div_2 / 2) xdiv++;

		let pm = Math.floor(xdiv / 8);
		let am = xdiv - 8 * pm;

		// FC0012 requires am >= 2 for valid PLL lock
		if (am < 2) {
			am += 8;
			pm--;
		}

		// Clamp and validate
		if (pm > 31) {
			am = am + 8 * (pm - 31);
			pm = 31;
		}
		if (am > 15 || pm < 0x0b) {
			console.warn(`FC0012: no valid PLL combination for ${freq} Hz`);
		}

		// Fractional part (delta-sigma) — 15-bit resolution per librtlsdr
		const f_remainder = f_vco - Math.floor(f_vco / xtal_freq_div_2) * xtal_freq_div_2;
		let xin = Math.floor(((f_remainder / 1000) * 32768) / (xtal_freq_div_2 / 1000));
		if (xin >= 16384) xin += 32768;
		xin = xin & 0xffff;

		// VCO speed selection
		let vcoSelect = 0;
		if (f_vco >= 3060000000) {
			reg6val |= 0x08;
			vcoSelect = 1;
		}

		// Fix clock out (bit 5)
		reg6val |= 0x20;

		// Write PLL registers 1-6
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x01, am);
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x02, pm);
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x03, (xin >> 8) & 0xff);
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x04, xin & 0xff);

		// Modified for Realtek demod: OR in 0x07 to reg5
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x05, reg5val | 0x07);

		// Build reg 6: band bits + VCO speed + clock out + bandwidth (6MHz = 0x80)
		let reg6 = reg6val | 0x80; // 6 MHz bandwidth
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x06, reg6);

		// VCO calibration
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x0e, 0x80);
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x0e, 0x00);

		// Allow VCO to settle before readback — the PLL needs time to lock
		// after calibration, especially during rapid frequency changes where
		// the previous VCO state may still be draining.
		await new Promise((r) => setTimeout(r, 5));

		// VCO re-calibration: read back and adjust if out of range
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x0e, 0x00);
		try {
			const vcoCal = await this.com.readI2CReg(FC0012_I2C_ADDR, 0x0e);
			const vcoTmp = vcoCal & 0x3f;
			if (vcoSelect) {
				if (vcoTmp > 0x3c) {
					reg6 &= ~0x08;
					await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x06, reg6);
					await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x0e, 0x80);
					await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x0e, 0x00);
				}
			} else {
				if (vcoTmp < 0x02) {
					reg6 |= 0x08;
					await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x06, reg6);
					await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x0e, 0x80);
					await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x0e, 0x00);
				}
			}
		} catch (_) {
			console.warn('FC0012: VCO calibration readback failed');
		}

		console.log(
			`FC0012: tuned to ${(freq / 1e6).toFixed(3)} MHz (multi=${multi}, pm=${pm}, am=${am}, xin=${xin}, vco=${(f_vco / 1e6).toFixed(0)}MHz)`,
		);
		return freq;
	}

	async setAutoGain(): Promise<void> {
		// Enable AGC, disable forced LNA gain
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x0d, 0x00);
	}

	getGains(): number[] {
		return FC0012_GAINS;
	}

	async setManualGain(gainIdx: number): Promise<void> {
		// FC0012 has 5 discrete LNA gain steps (from librtlsdr tuner_fc0012.c).
		// We expect gainIdx precisely from 0 to 4.
		const index = Math.max(0, Math.min(gainIdx, FC0012_GAIN_REGS.length - 1));
		const lnaBits = FC0012_GAIN_REGS[index];

		// Read-modify-write register 0x13: preserve bits 5-7, set gain in bits 0-4
		// (matches librtlsdr fc0012_set_gain)
		const reg13 = await this.com.readI2CReg(FC0012_I2C_ADDR, 0x13);
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x13, (reg13 & 0xe0) | lnaBits);
	}

	async close(): Promise<void> {
		// Power down the tuner — no specific shutdown needed for FC0012
	}
}
