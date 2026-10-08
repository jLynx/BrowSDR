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

// ── FC2580 Tuner ──────────────────────────────────────────────────
// Source: tuner_fc2580.c (FCI / Terratec / GPL-2.0)
export const FC2580_I2C_ADDR = 0xac;
export const FC2580_CRYSTAL_KHZ = 16384; // 16.384 MHz internal crystal
export const FC2580_BORDER_FREQ = 2600000; // kHz — VCO band boundary

export class FC2580 {
	private com: RtlCom;

	constructor(com: RtlCom) {
		this.com = com;
	}

	private async wr(reg: number, val: number): Promise<void> {
		await this.com.writeI2CReg(FC2580_I2C_ADDR, reg, val);
	}

	private async rd(reg: number): Promise<number> {
		return this.com.readI2CReg(FC2580_I2C_ADDR, reg);
	}

	async init(): Promise<void> {
		// fc2580_set_init() with external AGC mode
		const fxKhz = FC2580_CRYSTAL_KHZ;
		await this.wr(0x00, 0x00);
		await this.wr(0x12, 0x86);
		await this.wr(0x14, 0x5c);
		await this.wr(0x16, 0x3c);
		await this.wr(0x1f, 0xd2);
		await this.wr(0x09, 0xd7);
		await this.wr(0x0b, 0xd5);
		await this.wr(0x0c, 0x32);
		await this.wr(0x0e, 0x43);
		await this.wr(0x21, 0x0a);
		await this.wr(0x22, 0x82);
		// External AGC
		await this.wr(0x45, 0x20);
		await this.wr(0x4c, 0x02);
		await this.wr(0x3f, 0x88);
		await this.wr(0x02, 0x0e);
		await this.wr(0x58, 0x14);
		// Default filter: BW = 7.8 MHz
		await this.setFilter(8, fxKhz);
		console.log('FC2580: initialized');
	}

	async setFrequency(freq: number): Promise<number> {
		// FC2580 frequency is in kHz internally
		const { band, data02: initialData02, fLoKhz, fxKhz, rVal, kVal, nVal } = calculateFc2580Pll(freq);
		let data02 = initialData02; // high VCO

		// Band-specific register writes
		if (band === 'UHF') {
			data02 = data02 & 0x3f; // UHF band bits
			await this.wr(0x25, 0xf0);
			await this.wr(0x27, 0x77);
			await this.wr(0x28, 0x53);
			await this.wr(0x29, 0x60);
			await this.wr(0x30, 0x09);
			await this.wr(0x50, 0x8c);
			await this.wr(0x53, 0x50);
			await this.wr(0x5f, fLoKhz < 538000 ? 0x13 : 0x15);
			if (fLoKhz < 538000) {
				await this.wr(0x61, 0x07);
				await this.wr(0x62, 0x06);
				await this.wr(0x67, 0x06);
				await this.wr(0x68, 0x08);
				await this.wr(0x69, 0x10);
				await this.wr(0x6a, 0x12);
			} else if (fLoKhz < 794000) {
				await this.wr(0x61, 0x03);
				await this.wr(0x62, 0x03);
				await this.wr(0x67, 0x03);
				await this.wr(0x68, 0x05);
				await this.wr(0x69, 0x0c);
				await this.wr(0x6a, 0x0e);
			} else {
				await this.wr(0x61, 0x07);
				await this.wr(0x62, 0x06);
				await this.wr(0x67, 0x07);
				await this.wr(0x68, 0x09);
				await this.wr(0x69, 0x10);
				await this.wr(0x6a, 0x12);
			}
			await this.wr(0x63, 0x15);
			await this.wr(0x6b, 0x0b);
			await this.wr(0x6c, 0x0c);
			await this.wr(0x6d, 0x78);
			await this.wr(0x6e, 0x32);
			await this.wr(0x6f, 0x14);
			await this.setFilter(8, fxKhz);
			await this.wr(0x2d, fLoKhz <= 794000 ? 0x9f : 0x8f);
		} else if (band === 'VHF') {
			data02 = (data02 & 0x3f) | 0x80;
			await this.wr(0x27, 0x77);
			await this.wr(0x28, 0x33);
			await this.wr(0x29, 0x40);
			await this.wr(0x30, 0x09);
			await this.wr(0x50, 0x8c);
			await this.wr(0x53, 0x50);
			await this.wr(0x5f, 0x0f);
			await this.wr(0x61, 0x07);
			await this.wr(0x62, 0x00);
			await this.wr(0x63, 0x15);
			await this.wr(0x67, 0x03);
			await this.wr(0x68, 0x05);
			await this.wr(0x69, 0x10);
			await this.wr(0x6a, 0x12);
			await this.wr(0x6b, 0x08);
			await this.wr(0x6c, 0x0a);
			await this.wr(0x6d, 0x78);
			await this.wr(0x6e, 0x32);
			await this.wr(0x6f, 0x54);
			await this.setFilter(7, fxKhz);
		} else {
			// L-band
			data02 = (data02 & 0x3f) | 0x40;
			await this.wr(0x2b, 0x70);
			await this.wr(0x2c, 0x37);
			await this.wr(0x2d, 0xe7);
			await this.wr(0x30, 0x09);
			await this.wr(0x44, 0x20);
			await this.wr(0x50, 0x8c);
			await this.wr(0x53, 0x50);
			await this.wr(0x5f, 0x0f);
			await this.wr(0x61, 0x0f);
			await this.wr(0x62, 0x00);
			await this.wr(0x63, 0x13);
			await this.wr(0x67, 0x00);
			await this.wr(0x68, 0x02);
			await this.wr(0x69, 0x0c);
			await this.wr(0x6a, 0x0e);
			await this.wr(0x6b, 0x08);
			await this.wr(0x6c, 0x0a);
			await this.wr(0x6d, 0xa0);
			await this.wr(0x6e, 0x50);
			await this.wr(0x6f, 0x14);
			await this.setFilter(1, fxKhz);
		}

		// AGC clock pre-divide for xtal >= 28 MHz (always true for RTL-SDR 28.8MHz context
		// but FC2580 uses internal 16.384 MHz, so this only applies if xtal > 28000 kHz - skip)

		// VCO band + PLL programming
		await this.wr(0x02, data02);
		const rBits = rVal === 1 ? 0x00 : rVal === 2 ? 0x10 : 0x20;
		await this.wr(0x18, rBits | ((kVal >> 16) & 0x0f));
		await this.wr(0x1a, (kVal >> 8) & 0xff);
		await this.wr(0x1b, kVal & 0xff);
		await this.wr(0x1c, nVal & 0xff);

		console.log(`FC2580: tuned to ${(freq / 1e6).toFixed(3)} MHz (band=${band}, n=${nVal}, k=${kVal}, r=${rVal})`);
		return freq;
	}

	private async setFilter(bw: number, fxKhz: number): Promise<void> {
		// fc2580_set_filter() — bw: 1=1.53MHz, 6=6MHz, 7=6.8MHz, 8=7.8MHz
		if (bw === 1) {
			await this.wr(0x36, 0x1c);
			await this.wr(0x37, Math.floor((4151 * fxKhz) / 1000000) & 0xff);
			await this.wr(0x39, 0x00);
			await this.wr(0x2e, 0x09);
		} else if (bw === 6) {
			await this.wr(0x36, 0x18);
			await this.wr(0x37, Math.floor((4400 * fxKhz) / 1000000) & 0xff);
			await this.wr(0x39, 0x00);
			await this.wr(0x2e, 0x09);
		} else if (bw === 7) {
			await this.wr(0x36, 0x18);
			await this.wr(0x37, Math.floor((3910 * fxKhz) / 1000000) & 0xff);
			await this.wr(0x39, 0x80);
			await this.wr(0x2e, 0x09);
		} else {
			// bw === 8, default
			await this.wr(0x36, 0x18);
			await this.wr(0x37, Math.floor((3300 * fxKhz) / 1000000) & 0xff);
			await this.wr(0x39, 0x80);
			await this.wr(0x2e, 0x09);
		}
		// Poll calibration lock (up to 5 attempts)
		for (let i = 0; i < 5; i++) {
			const cal = await this.rd(0x2f);
			if ((cal & 0xc0) === 0xc0) break;
			await this.wr(0x2e, 0x01);
			await this.wr(0x2e, 0x09);
		}
		await this.wr(0x2e, 0x01);
	}

	async setAutoGain(): Promise<void> {
		// External AGC — registers already set in init(); nothing more needed
	}

	setManualGain(_gain: number): Promise<void> {
		// FC2580 doesn't expose a direct LNA gain register in this driver;
		// gain is handled by the external AGC on the RTL2832U side.
		console.warn('FC2580: manual gain not supported, using AGC');

		return Promise.resolve();
	}

	async close(): Promise<void> {
		// No specific shutdown sequence for FC2580
	}
}

function calculateFc2580Pll(freq: number) {
	const fLoKhz = Math.round(freq / 1000);
	const fxKhz = FC2580_CRYSTAL_KHZ;

	// Band selection
	const band = fLoKhz > 1000000 ? 'L' : fLoKhz > 400000 ? 'UHF' : 'VHF';

	// Multiplier per band
	const bandMult = band === 'UHF' ? 4 : band === 'L' ? 2 : 12;
	const fVco = fLoKhz * bandMult;

	// R value: choose reference divider so f_comp is in right range
	const rVal = fVco >= 2 * 76 * fxKhz ? 1 : fVco >= 76 * fxKhz ? 2 : 4;
	const fComp = fxKhz / rVal;

	// N and K (fractional)
	const nVal = Math.floor(fVco / 2 / fComp);
	const fDiff = fVco - 2 * fComp * nVal;
	const preShift = 4;
	const fDiffShifted = fDiff << (20 - preShift);
	const divisor = (2 * fComp) >> preShift;
	let kVal = Math.floor(fDiffShifted / divisor);
	if (fDiffShifted - kVal * divisor >= fComp >> preShift) kVal++;

	// Build data_0x02: VCO band + R + band bits
	let data02 = 0x0e; // USE_EXT_CLK=0, default
	if (fVco >= FC2580_BORDER_FREQ) data02 |= 0x08; // high VCO
	return { band, data02, fLoKhz, fxKhz, rVal, kVal, nVal };
}
