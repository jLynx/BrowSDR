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

// ── E4000 Tuner ───────────────────────────────────────────────────
// Ported from tuner_e4k.c (Harald Welte / Sylvain Munaut / GPL-2.0)
export const E4K_I2C_ADDR = 0xc8;
export const E4K_CHECK_ADDR = 0x02;
export const E4K_CHECK_VAL = 0x40;

// E4000 register addresses (from tuner_e4k.h)
export const E4K_REG_MASTER1 = 0x00;
export const E4K_REG_CLK_INP = 0x05;
export const E4K_REG_REF_CLK = 0x06;
export const E4K_REG_CLKOUT_PWDN = 0x0a;
export const E4K_REG_SYNTH1 = 0x0d;
export const E4K_REG_SYNTH3 = 0x0f;
export const E4K_REG_SYNTH4 = 0x10;
export const E4K_REG_SYNTH5 = 0x11;
export const E4K_REG_SYNTH7 = 0x13;
export const E4K_REG_FILT1 = 0x29;
export const E4K_REG_FILT2 = 0x2a;
export const E4K_REG_FILT3 = 0x2b;
export const E4K_REG_GAIN1 = 0x44;
export const E4K_REG_GAIN2 = 0x45;
export const E4K_REG_GAIN3 = 0x46;
export const E4K_REG_GAIN4 = 0x47;
export const E4K_REG_AGC1 = 0x4c;
export const E4K_REG_AGC4 = 0x4f;
export const E4K_REG_AGC5 = 0x50;
export const E4K_REG_AGC6 = 0x51;
export const E4K_REG_AGC7 = 0x53;
export const E4K_REG_AGC8 = 0x54;
export const E4K_REG_AGC11 = 0x57;
export const E4K_REG_BIAS = 0x7e;
export const E4K_REG_DC1 = 0x70;
export const E4K_REG_DC2 = 0x71;
export const E4K_REG_DC3 = 0x72;
export const E4K_REG_DC4 = 0x73;
export const E4K_REG_DC5 = 0x74;
export const E4K_REG_DCTIME1 = 0x75;
export const E4K_REG_DCTIME2 = 0x76;

// Master1 bits
export const E4K_MASTER1_RESET = 0x01;
export const E4K_MASTER1_NORM_STBY = 0x02;
export const E4K_MASTER1_POR_DET = 0x04;
// AGC bits
export const E4K_AGC1_MOD_MASK = 0x0f;
export const E4K_AGC_MOD_SERIAL = 0x00;
export const E4K_AGC_MOD_IF_SERIAL_LNA_AUTON = 0x0d;
export const E4K_AGC7_MIX_GAIN_AUTO = 0x01;
export const E4K_AGC11_LNA_GAIN_ENH = 0x01;
export const E4K_FILT3_DISABLE = 0x04;
export const E4K_DC5_RANGE_DET_EN = 0x04;

// PLL constants
export const E4K_PLL_Y = 65536;
export const E4K_FOSC_MIN = 16000000;
export const E4K_FOSC_MAX = 30000000;
export const E4K_FLO_MIN = 50000000; // OUT_OF_SPEC
export const E4K_FLO_MAX = 2200000000; // OUT_OF_SPEC
export const E4K_FVCO_MIN = 2600000000;
export const E4K_FVCO_MAX = 3900000000;

// PLL vars table: {maxFlo Hz, reg_synth7, mult}
export const E4K_PLL_VARS: Array<{ freq: number; regSynth7: number; mult: number }> = [
	{ freq: 72400000, regSynth7: (1 << 3) | 7, mult: 48 },
	{ freq: 81200000, regSynth7: (1 << 3) | 6, mult: 40 },
	{ freq: 108300000, regSynth7: (1 << 3) | 5, mult: 32 },
	{ freq: 162500000, regSynth7: (1 << 3) | 4, mult: 24 },
	{ freq: 216600000, regSynth7: (1 << 3) | 3, mult: 16 },
	{ freq: 325000000, regSynth7: (1 << 3) | 2, mult: 12 },
	{ freq: 350000000, regSynth7: (1 << 3) | 1, mult: 8 },
	{ freq: 432000000, regSynth7: (0 << 3) | 3, mult: 8 },
	{ freq: 667000000, regSynth7: (0 << 3) | 2, mult: 6 },
	{ freq: 1200000000, regSynth7: (0 << 3) | 1, mult: 4 },
];

// Band enum (matches the C enum e4k_band)
export const E4K_BAND_VHF2 = 0;
export const E4K_BAND_VHF3 = 1;
export const E4K_BAND_UHF = 2;
export const E4K_BAND_L = 3;

// RF filter center frequencies (Hz): UHF and L
export const E4K_RF_FILT_UHF = [
	360e6, 380e6, 405e6, 425e6, 450e6, 475e6, 505e6, 540e6, 575e6, 615e6, 670e6, 720e6, 760e6, 840e6, 890e6, 970e6,
];
export const E4K_RF_FILT_L = [
	1300e6, 1320e6, 1360e6, 1410e6, 1445e6, 1460e6, 1490e6, 1530e6, 1560e6, 1590e6, 1640e6, 1660e6, 1680e6, 1700e6, 1720e6, 1750e6,
];

// IF filter bandwidths (Hz)
export const E4K_MIX_FILTER_BW = [
	27000000, 27000000, 27000000, 27000000, 27000000, 27000000, 27000000, 27000000, 4600000, 4200000, 3800000, 3400000, 3300000, 2700000,
	2300000, 1900000,
];
export const E4K_IFRC_FILTER_BW = [
	21400000, 21000000, 17600000, 14700000, 12400000, 10600000, 9000000, 7700000, 6400000, 5300000, 4400000, 3400000, 2600000, 1800000,
	1200000, 1000000,
];
export const E4K_IFCH_FILTER_BW = [
	5500000, 5300000, 5000000, 4800000, 4600000, 4400000, 4300000, 4100000, 3900000, 3800000, 3700000, 3600000, 3400000, 3300000, 3200000,
	3100000, 3000000, 2950000, 2900000, 2800000, 2750000, 2700000, 2600000, 2550000, 2500000, 2450000, 2400000, 2300000, 2280000, 2240000,
	2200000, 2150000,
];

// LNA gain table: [gain_tenth_dB, register_value]
export const E4K_LNA_GAIN: Array<[number, number]> = [
	[-50, 0],
	[-25, 1],
	[0, 4],
	[25, 5],
	[50, 6],
	[75, 7],
	[100, 8],
	[125, 9],
	[150, 10],
	[175, 11],
	[200, 12],
	[250, 13],
	[300, 14],
];

export function e4kClosestIdx(arr: number[], freq: number): number {
	let bestDelta = Infinity;
	let bestIdx = 0;
	for (let i = 0; i < arr.length; i++) {
		const d = Math.abs(arr[i] - freq);
		if (d < bestDelta) {
			bestDelta = d;
			bestIdx = i;
		}
	}
	return bestIdx;
}

export class E4000 {
	private com: RtlCom;
	private fosc: number;
	private band = -1;

	constructor(com: RtlCom, fosc: number) {
		this.com = com;
		this.fosc = fosc;
	}

	/** Direct I2C register read for E4000 */
	private async regRead(reg: number): Promise<number> {
		return this.com.readI2CReg(E4K_I2C_ADDR, reg);
	}

	/** Direct I2C register write for E4000 */
	private async regWrite(reg: number, val: number): Promise<void> {
		return this.com.writeI2CReg(E4K_I2C_ADDR, reg, val);
	}

	/** Read-modify-write a masked register */
	private async regSetMask(reg: number, mask: number, val: number): Promise<void> {
		const cur = await this.regRead(reg);
		if ((cur & mask) === (val & mask)) return;
		await this.regWrite(reg, (cur & ~mask) | (val & mask));
	}

	async init(): Promise<void> {
		// Dummy read to wake up
		try {
			await this.regRead(0);
		} catch (_) {
			/* expected NACK */
		}

		// Reset + clear POR indicator
		await this.regWrite(E4K_REG_MASTER1, E4K_MASTER1_RESET | E4K_MASTER1_NORM_STBY | E4K_MASTER1_POR_DET);

		// Configure clock
		await this.regWrite(E4K_REG_CLK_INP, 0x00);
		await this.regWrite(E4K_REG_REF_CLK, 0x00);
		await this.regWrite(E4K_REG_CLKOUT_PWDN, 0x96);

		// Magic init values (from tuner_e4k.c magic_init)
		await this.regWrite(0x7e, 0x01);
		await this.regWrite(0x7f, 0xfe);
		await this.regWrite(0x82, 0x00);
		await this.regWrite(0x86, 0x50);
		await this.regWrite(0x87, 0x20);
		await this.regWrite(0x88, 0x01);
		await this.regWrite(0x9f, 0x7f);
		await this.regWrite(0xa0, 0x07);

		// AGC setup
		await this.regWrite(E4K_REG_AGC4, 0x10); // High threshold
		await this.regWrite(E4K_REG_AGC5, 0x04); // Low threshold
		await this.regWrite(E4K_REG_AGC6, 0x1a); // LNA calib + loop rate

		// Manual AGC (LNA serial mode)
		await this.regSetMask(E4K_REG_AGC1, E4K_AGC1_MOD_MASK, E4K_AGC_MOD_SERIAL);
		// Mixer gain manual
		await this.regSetMask(E4K_REG_AGC7, E4K_AGC7_MIX_GAIN_AUTO, 0);

		// Switch to auto-gain
		await this.setAutoGain();

		// Moderate IF gain defaults
		await this.setIfGain(1, 6);
		await this.setIfGain(2, 0);
		await this.setIfGain(3, 0);
		await this.setIfGain(4, 0);
		await this.setIfGain(5, 9);
		await this.setIfGain(6, 9);

		// Set IF filters to narrowest useful settings
		await this.setIfFilterBw(0, 1900000); // mixer: 1.9 MHz
		await this.setIfFilterBw(2, 1000000); // IF RC: 1 MHz
		await this.setIfFilterBw(1, 2150000); // IF channel: 2.15 MHz
		// Enable channel filter
		await this.regSetMask(E4K_REG_FILT3, E4K_FILT3_DISABLE, 0);

		// Disable time variant DC correction and LUT
		await this.regSetMask(E4K_REG_DC5, 0x03, 0);
		await this.regSetMask(E4K_REG_DCTIME1, 0x03, 0);
		await this.regSetMask(E4K_REG_DCTIME2, 0x03, 0);

		console.log(`[E4K] Initialized (fosc=${(this.fosc / 1e6).toFixed(3)} MHz)`);
	}

	async setFrequency(freq: number): Promise<number> {
		if (freq < E4K_FLO_MIN || freq > E4K_FLO_MAX) {
			console.warn(`[E4K] Frequency ${freq} Hz out of range`);
		}

		// Find PLL entry: first entry whose max freq > requested freq
		let rIdx = E4K_PLL_VARS[E4K_PLL_VARS.length - 1].regSynth7;
		let mult = E4K_PLL_VARS[E4K_PLL_VARS.length - 1].mult;
		for (const v of E4K_PLL_VARS) {
			if (freq < v.freq) {
				rIdx = v.regSynth7;
				mult = v.mult;
				break;
			}
		}

		const fosc = this.fosc;

		// Compute Fvco target
		// Use BigInt to avoid float precision loss at high freq * mult values
		const intendedFvco = freq * mult;

		// Integer Z: floor(Fvco / Fosc)
		const z = Math.floor(intendedFvco / fosc);
		if (z > 255) {
			console.error('[E4K] Z out of range:', z);
			return -1;
		}

		// Fractional X: (remainder * Y) / Fosc
		const remainder = intendedFvco - fosc * z;
		const x = Math.floor((remainder * E4K_PLL_Y) / fosc) & 0xffff;

		// Compute actual tuned frequency
		const fvco = fosc * z + (fosc * x) / E4K_PLL_Y;
		const flo = Math.round(fvco / mult);

		// Program PLL
		await this.regWrite(E4K_REG_SYNTH7, rIdx); // R + 3phase/2phase
		await this.regWrite(E4K_REG_SYNTH3, z & 0xff); // Z integer part
		await this.regWrite(E4K_REG_SYNTH4, x & 0xff); // X low byte
		await this.regWrite(E4K_REG_SYNTH5, (x >> 8) & 0xff); // X high byte

		// Set band
		await this.setBand(flo);

		// Set RF filter
		await this.setRfFilter(flo);

		// Check PLL lock
		const synth1 = await this.regRead(E4K_REG_SYNTH1);
		if (!(synth1 & 0x01)) {
			console.warn(`[E4K] PLL not locked for ${(freq / 1e6).toFixed(3)} MHz (synth1=0x${synth1.toString(16)})`);
		}

		console.log(`[E4K] tuned: req=${(freq / 1e6).toFixed(3)}MHz actual=${(flo / 1e6).toFixed(3)}MHz z=${z} x=${x} mult=${mult}`);
		return flo;
	}

	private async setBand(flo: number): Promise<void> {
		let band: number;
		if (flo < 140e6) band = E4K_BAND_VHF2;
		else if (flo < 350e6) band = E4K_BAND_VHF3;
		else if (flo < 1135e6) band = E4K_BAND_UHF;
		else band = E4K_BAND_L;

		if (band === this.band) return;
		this.band = band;

		// Set bias
		const biasVal = band === E4K_BAND_L ? 0 : 3;
		await this.regWrite(E4K_REG_BIAS, biasVal);

		// Workaround: reset SYNTH1 band bits before writing to avoid 325-350 MHz gap
		await this.regSetMask(E4K_REG_SYNTH1, 0x06, 0);
		await this.regSetMask(E4K_REG_SYNTH1, 0x06, band << 1);
	}

	private async setRfFilter(flo: number): Promise<void> {
		let idx = 0;
		if (flo >= 350e6 && flo < 1135e6) {
			idx = e4kClosestIdx(E4K_RF_FILT_UHF, flo);
		} else if (flo >= 1135e6) {
			idx = e4kClosestIdx(E4K_RF_FILT_L, flo);
		}
		// VHF2/VHF3: idx=0 (no filter needed)
		await this.regSetMask(E4K_REG_FILT1, 0x0f, idx);
	}

	/** Set IF filter by index: 0=mixer, 1=IF channel, 2=IF RC */
	private async setIfFilterBw(filter: number, bw: number): Promise<void> {
		// Tables and field descriptors: {table, reg, shift, width}
		const filters = [
			{ table: E4K_MIX_FILTER_BW, reg: E4K_REG_FILT2, shift: 4, width: 4 },
			{ table: E4K_IFCH_FILTER_BW, reg: E4K_REG_FILT3, shift: 0, width: 5 },
			{ table: E4K_IFRC_FILTER_BW, reg: E4K_REG_FILT2, shift: 0, width: 4 },
		];
		if (filter >= filters.length) return;
		const f = filters[filter];
		const idx = e4kClosestIdx(f.table, bw);
		const mask = ((1 << f.width) - 1) << f.shift;
		await this.regSetMask(f.reg, mask, idx << f.shift);
	}

	/** Set IF gain for stage 1–6 */
	private async setIfGain(stage: number, value: number): Promise<void> {
		// Stage gain fields: {reg, shift, width, gainTable}
		const IF1 = [-3, 6];
		const IF23 = [0, 3, 6, 9];
		const IF4 = [0, 1, 2, 2];
		const IF56 = [3, 6, 9, 12, 15, 15, 15, 15];
		const stageInfo = [
			null, // stage 0 unused
			{ reg: E4K_REG_GAIN3, shift: 0, width: 1, gains: IF1 },
			{ reg: E4K_REG_GAIN3, shift: 1, width: 2, gains: IF23 },
			{ reg: E4K_REG_GAIN3, shift: 3, width: 2, gains: IF23 },
			{ reg: E4K_REG_GAIN3, shift: 5, width: 2, gains: IF4 },
			{ reg: E4K_REG_GAIN4, shift: 0, width: 3, gains: IF56 },
			{ reg: E4K_REG_GAIN4, shift: 3, width: 3, gains: IF56 },
		];
		if (stage < 1 || stage > 6) return;
		const s = stageInfo[stage]!;
		const idx = s.gains.indexOf(value);
		if (idx < 0) return;
		const mask = ((1 << s.width) - 1) << s.shift;
		await this.regSetMask(s.reg, mask, idx << s.shift);
	}

	async setAutoGain(): Promise<void> {
		// LNA auto
		await this.regSetMask(E4K_REG_AGC1, E4K_AGC1_MOD_MASK, E4K_AGC_MOD_IF_SERIAL_LNA_AUTON);
		// Mixer gain auto
		await this.regSetMask(E4K_REG_AGC7, E4K_AGC7_MIX_GAIN_AUTO, 1);
		// Disable LNA gain enhancement
		await this.regSetMask(E4K_REG_AGC11, 0x07, 0);
	}

	getGains(): number[] {
		return E4K_LNA_GAIN.map((g) => g[0]);
	}

	async setManualGain(gainIdx: number): Promise<void> {
		// Receive slider index
		const index = Math.max(0, Math.min(gainIdx, E4K_LNA_GAIN.length - 1));
		const bestRegVal = E4K_LNA_GAIN[index][1];

		// Set manual mode
		await this.regSetMask(E4K_REG_AGC1, E4K_AGC1_MOD_MASK, E4K_AGC_MOD_SERIAL);
		await this.regSetMask(E4K_REG_AGC7, E4K_AGC7_MIX_GAIN_AUTO, 0);
		// Write LNA gain register
		await this.regSetMask(E4K_REG_GAIN1, 0x0f, bestRegVal);
	}

	async close(): Promise<void> {
		// Standby mode
		await this.regSetMask(E4K_REG_MASTER1, E4K_MASTER1_NORM_STBY, 0);
	}
}
