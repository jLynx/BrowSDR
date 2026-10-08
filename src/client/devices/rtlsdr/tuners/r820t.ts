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

import { IF_FREQ } from '@/devices/rtlsdr/protocol';
import type { RtlCom } from '@/devices/rtlsdr/usb';

// ── R820T Tuner Constants ─────────────────────────────────────────
export const R820T_I2C_ADDR = 0x34;
export const R828D_I2C_ADDR = 0x74;
export const R820T_CHECK_VAL = 0x96;

// Initial register values for R8xx (registers 0x05–0x1f, 27 bytes).
// Matches R8xx.REGISTERS from jtarrio/webrtlsdr r8xx.ts.
export const R820T_INIT_REGS = [
	// 0x05: loop-through off, LNA auto, LNA gain 3
	0b10000011,
	// 0x06: power det 1 on, power det 3 off, filter gain +3dB, LNA pwr 2
	0b00110010,
	// 0x07: mixer pwr on, mixer current normal, mixer auto, mixer gain 5
	0b01110101,
	// 0x08: mixer buf pwr on, mixer buf low current, image gain adj 0
	0b11000000,
	// 0x09: IF filter off, IF filter low current, image phase adj 0
	0b01000000,
	// 0x0a: channel filter on, filter pwr 2, filter bw fine 6
	0b11010110,
	// 0x0b: filter bw coarse 3, high pass corner 12
	0b01101100,
	// 0x0c: VGA pwr on, VGA gain pin, VGA gain 5.5dB
	0b11110101,
	// 0x0d: LNA agc thresh high 0.94V, low 0.64V
	0b01100011,
	// 0x0e: mixer agc thresh high 1.04V, low 0.84V
	0b01110101,
	// 0x0f: LDO 3.0V, clock output off, internal agc clock on
	0b01101000,
	// 0x10: PLL to mixer div 1:1, PLL div 1, xtal swing low, no cap
	0b01101100,
	// 0x11: PLL analog reg 2.0V
	0b10000011,
	// 0x12
	0b10000000,
	// 0x13
	0b00000000,
	// 0x14: NI2C = 15
	0b00001111,
	// 0x15: SDM_IN[16:9]
	0b00000000,
	// 0x16: SDM_IN[8:1]
	0b11000000,
	// 0x17: PLL digital reg 1.8V, open drain high-Z
	0b00110000,
	// 0x18
	0b01001000,
	// 0x19: RF filter pwr on, agc_pin=agc_in
	0b11001100,
	// 0x1a: tracking filter bypass, PLL auto-tune 128kHz, RF filter highest
	0b01100000,
	// 0x1b: highest corner LPNF/LPF
	0b00000000,
	// 0x1c: power det 3 TOP 5
	0b01010100,
	// 0x1d: power det 1 TOP 5, power det 2 TOP 6
	0b10101110,
	// 0x1e: filter extension enable, power det timing control 10
	0b01001010,
	// 0x1f
	0b11000000,
];

// Multiplexer configurations per frequency band.
// [startMHz, open_d (R0x17 bit3), rf_mux_ploy (R0x1a bits 7:6,1:0), tf_c (R0x1b)]
// Matches STD_MUX_CFGS from jtarrio/webrtlsdr r8xx.ts.
export const MUX_CFGS: Array<[number, number, number, number]> = [
	[0, 0b1000, 0b00000010, 0b11011111],
	[50, 0b1000, 0b00000010, 0b10111110],
	[55, 0b1000, 0b00000010, 0b10001011],
	[60, 0b1000, 0b00000010, 0b01111011],
	[65, 0b1000, 0b00000010, 0b01101001],
	[70, 0b1000, 0b00000010, 0b01011000],
	[75, 0b0000, 0b00000010, 0b01000100],
	[90, 0b0000, 0b00000010, 0b00110100],
	[110, 0b0000, 0b00000010, 0b00100100],
	[140, 0b0000, 0b00000010, 0b00010100],
	[180, 0b0000, 0b00000010, 0b00010011],
	[250, 0b0000, 0b00000010, 0b00010001],
	[280, 0b0000, 0b00000010, 0b00000000],
	[310, 0b0000, 0b01000001, 0b00000000],
	[588, 0b0000, 0b01000000, 0b00000000],
];

// Experimentally: LNA goes in 2.3dB steps, Mixer in 1.2dB steps.
// (matches setManualGain logic in jtarrio/webrtlsdr r8xx.ts)

// R820T gain tables — from librtlsdr tuner_r82xx.c
export const R82XX_LNA_GAIN_STEPS = [0, 9, 13, 40, 38, 13, 31, 22, 26, 31, 26, 14, 19, 5, 35, 13];
export const R82XX_MIXER_GAIN_STEPS = [0, 5, 10, 10, 19, 9, 10, 25, 17, 10, 8, 16, 13, 6, 3, -8];
// 29 discrete gain values (tenths of dB) — matches rtlsdr_get_tuner_gains()
export const R82XX_GAINS = [
	0, 9, 14, 27, 37, 77, 87, 125, 144, 157, 166, 197, 207, 229, 254, 280, 297, 328, 338, 364, 372, 386, 402, 421, 434, 439, 445, 480, 496,
];

export const BIT_REVS = [0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe, 0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf];

export class R820T {
	private com: RtlCom;
	private xtalFreq: number;
	private ifFreq: number; // IF frequency (3.57 MHz typical) — added to PLL freq
	private i2cAddr: number;
	private vcoPowerRef: number; // R820T=2, R828D=1
	private isR828D: boolean;
	private isBlogV4: boolean;
	private shadowRegs!: Uint8Array;
	private hasPllLock = false;
	private lastInput = -1; // R828D antenna input tracking
	private gpioCallback: ((gpio: number, on: boolean) => Promise<void>) | null;

	constructor(
		com: RtlCom,
		xtalFreq: number,
		i2cAddr = R820T_I2C_ADDR,
		isR828D = false,
		isBlogV4 = false,
		ifFreq = IF_FREQ,
		gpioCallback: ((gpio: number, on: boolean) => Promise<void>) | null = null,
	) {
		this.com = com;
		this.xtalFreq = xtalFreq;
		this.ifFreq = ifFreq;
		this.i2cAddr = i2cAddr;
		this.isR828D = isR828D;
		this.isBlogV4 = isBlogV4;
		this.gpioCallback = gpioCallback;
		// R828D uses VCO power ref of 1; R820T/R820T2 uses 2
		this.vcoPowerRef = isR828D ? 1 : 2;
	}

	private i2cWrite(reg: number, val: number) {
		return this.com.writeI2CReg(this.i2cAddr, reg, val);
	}

	private i2cReadBuf(addr: number, len: number) {
		return this.com.readI2CRegBuffer(this.i2cAddr, addr, len);
	}

	async init(): Promise<void> {
		this.shadowRegs = new Uint8Array(R820T_INIT_REGS);
		for (let i = 0; i < R820T_INIT_REGS.length; i++) {
			await this.i2cWrite(i + 5, R820T_INIT_REGS[i]);
		}
		await this.initElectronics();
	}

	// setFrequency receives the raw user frequency.
	// The IF offset is added here before setting the PLL, matching
	// librtlsdr's lo_freq = upconvert_freq + priv->int_freq.
	async setFrequency(freq: number): Promise<number> {
		if (this.isBlogV4) {
			const upconvertFreq = freq <= 28800000 ? freq + 28800000 : freq;
			await this.setMux(upconvertFreq);

			const notchOff = freq <= 2200000 || (freq >= 85000000 && freq <= 112000000) || (freq >= 172000000 && freq <= 242000000);
			await this.writeRegMask(0x17, notchOff ? 0x00 : 0x08, 0x08);

			const band = freq <= 28800000 ? 0 : freq < 250000000 ? 1 : 2;
			if (band !== this.lastInput) {
				this.lastInput = band;
				await this.writeRegMask(0x06, band === 0 ? 0x08 : 0x00, 0x08); // cable2
				// GPIO 5 controls the upconverter bypass relay (matches librtlsdr)
				if (this.gpioCallback) await this.gpioCallback(5, band !== 0);
				await this.writeRegMask(0x05, band === 1 ? 0x40 : 0x00, 0x40); // cable1
				// air_in: active-low — clear for UHF (active), set for others (disabled)
				await this.writeRegMask(0x05, band === 2 ? 0x00 : 0x20, 0x20); // air_in
			}
			return await this.setPll(upconvertFreq + this.ifFreq);
		} else {
			const loFreq = freq + this.ifFreq;
			await this.setMux(freq);
			const result = await this.setPll(loFreq);
			// R828D: switch Cable1 LNA on/off at 345 MHz threshold
			if (this.isR828D) {
				const input = freq > 345000000 ? 0x00 : 0x60;
				if (input !== this.lastInput) {
					this.lastInput = input;
					await this.writeRegMask(0x05, input, 0x60);
				}
			}
			return result;
		}
	}

	async setAutoGain(): Promise<void> {
		// [4] lna gain auto
		await this.writeRegMask(0x05, 0b00000000, 0b00010000);
		// [4] mixer gain auto
		await this.writeRegMask(0x07, 0b00010000, 0b00010000);

		if (this.isBlogV4) {
			// VGA auto control does not work well on V4 (spectrum pumping). Fix to 0x08.
			await this.writeRegMask(0x0c, 0x08, 0x9f);
		} else {
			// [4] IF vga mode manual [3:0] IF vga gain 26.5dB
			await this.writeRegMask(0x0c, 0b00001011, 0b10011111);
		}
	}

	getGains(): number[] {
		return R82XX_GAINS;
	}

	async setManualGain(gainIdx: number): Promise<void> {
		// Slider value is an index into R82XX_GAINS (0-28).
		// Look up the target gain in tenths of dB, then use the
		// librtlsdr r82xx_set_gain algorithm to find LNA/mixer indices.
		const gainTenths = R82XX_GAINS[Math.min(gainIdx, R82XX_GAINS.length - 1)] ?? 0;
		let lnaIndex = 0;
		let mixIndex = 0;
		let totalGain = 0;
		for (let i = 0; i < 15; i++) {
			if (totalGain >= gainTenths) break;
			totalGain += R82XX_LNA_GAIN_STEPS[++lnaIndex];
			if (totalGain >= gainTenths) break;
			totalGain += R82XX_MIXER_GAIN_STEPS[++mixIndex];
		}
		// [4] LNA gain manual
		await this.writeRegMask(0x05, 0x10, 0x10);
		// [4] mixer gain manual
		await this.writeRegMask(0x07, 0x00, 0x10);
		// Read tuner status — librtlsdr reads 4 bytes from reg 0x00
		// between mode switch and VGA set to let the tuner latch
		await this.readRegBuffer(0x00, 4);
		// [4] VGA mode manual [3:0] VGA gain 16.3dB
		await this.writeRegMask(0x0c, 0x08, 0x9f);
		// [3:0] LNA gain index
		await this.writeRegMask(0x05, lnaIndex, 0x0f);
		// [3:0] mixer gain index
		await this.writeRegMask(0x07, mixIndex, 0x0f);
	}

	async close(): Promise<void> {
		// Matches R8xx.close() from jtarrio/webrtlsdr
		// [7] power det 1 off [6] power det 3 off [5] filter gain [2:0] LNA pwr 1
		await this.writeRegMask(0x06, 0b10110001, 0xff);
		// [7] loop through off [5] lna 1 pwr off [4] LNA gain manual [3:0] LNA gain 3
		await this.writeRegMask(0x05, 0b10110011, 0xff);
		// [6] mixer pwr off [5] mixer normal current [4] mixer gain auto [3:0] mixer gain 10
		await this.writeRegMask(0x07, 0b00111010, 0xff);
		// [7] mixer buf pwr off [6] mixer buf low current [5:0] image gain 0
		await this.writeRegMask(0x08, 0b01000000, 0xff);
		// [7] IF filter off [6] IF filter low current [5:0] image phase 0
		await this.writeRegMask(0x09, 0b11000000, 0xff);
		// [7] channel filter off [6:5] filter pwr 1 [3:0] filter bw 6
		await this.writeRegMask(0x0a, 0b00111010, 0xff);
		// [6] vga pwr off [4] vga controlled by pin [3:0] vga gain 5
		await this.writeRegMask(0x0c, 0b00110101, 0xff);
		// [4] clock output on [1] internal agc clock on
		await this.writeRegMask(0x0f, 0b01101000, 0xff);
		// [7:6] pll analog reg off
		await this.writeRegMask(0x11, 0b00000011, 0xff);
		// [7:6] pll digital reg off [3] open drain high-Z
		await this.writeRegMask(0x17, 0b11110100, 0xff);
		// [7] rf filter pwr off [4] agc pin = agc_in
		await this.writeRegMask(0x19, 0b00001100, 0xff);
	}

	private async initElectronics(): Promise<void> {
		// Matches R8xx._initElectronics() from jtarrio/webrtlsdr
		// [3:0] IF vga -12dB
		await this.writeRegMask(0x0c, 0b00000000, 0b00001111);
		// [5:0] VCO bank 49
		await this.writeRegMask(0x13, 0b00110001, 0b00111111);
		// [5:3] power detector 1 TOP 0
		await this.writeRegMask(0x1d, 0b00000000, 0b00111000);
		const filterCap = await this.calibrateFilter();
		// [4] channel filter high Q [3:0] filter bw manual fine tune
		await this.writeRegMask(0x0a, 0b00010000 | filterCap, 0b00011111);
		// [7:5] filter bw coarse 3 [3:0] high pass corner 11
		await this.writeRegMask(0x0b, 0b01101011, 0b11101111);
		// [7] mixer sideband lower
		await this.writeRegMask(0x07, 0b00000000, 0b10000000);
		// [5] filter gain 0dB [4] mixer filter 6MHz on
		await this.writeRegMask(0x06, 0b00010000, 0b00110000);
		// [6] filter extension enable [5] channel filter extension @ LNA max
		await this.writeRegMask(0x1e, 0b01000000, 0b01100000);
		// [7] loop through on
		await this.writeRegMask(0x05, 0b00000000, 0b10000000);
		// [7] loop through attenuation enable
		await this.writeRegMask(0x1f, 0b00000000, 0b10000000);
		// [7] filter extension widest off
		await this.writeRegMask(0x0f, 0b00000000, 0b10000000);
		// [6:5] RF poly filter current min
		await this.writeRegMask(0x19, 0b01100000, 0b01100000);
		// [7:6] LNA narrow band pwr det lowest BW [2:0] pwr det 2 TOP 5
		await this.writeRegMask(0x1d, 0b11100101, 0b11000111);
		// [7:4] pwr det 3 TOP 4
		await this.writeRegMask(0x1c, 0b00100100, 0b11111000);
		// [7:4] LNA agc pwr det threshold high 0.84V [3:0] low 0.64V
		await this.writeRegMask(0x0d, 0b01010011, 0b11111111);
		// [7:4] mixer agc pwr det threshold high 1.04V [3:0] low 0.84V
		await this.writeRegMask(0x0e, 0b01110101, 0b11111111);
		// [6] cable 1 LNA off [5] LNA 1 pwr on
		await this.writeRegMask(0x05, 0b00000000, 0b01100000);
		// [3] cable 2 LNA off
		await this.writeRegMask(0x06, 0b00000000, 0b00001000);
		// [3] prescale
		await this.writeRegMask(0x11, 0b00111000, 0b00001000);
		// [5:4] prescale 45 current 150u
		await this.writeRegMask(0x17, 0b00110000, 0b00110000);
		// [6:5] filter pwr 2
		await this.writeRegMask(0x0a, 0b01000000, 0b01100000);
		// [5:3] pwr det 1 TOP 0
		await this.writeRegMask(0x1d, 0b00000000, 0b00111000);
		// [2] LNA pwr det mode normal
		await this.writeRegMask(0x1c, 0b00000000, 0b00000100);
		// [6] LNA pwr det narrow band off
		await this.writeRegMask(0x06, 0b00000000, 0b01000000);
		// [5:4] AGC clock 20ms
		await this.writeRegMask(0x1a, 0b00110000, 0b00110000);
		// [5:3] pwr det 1 TOP 3
		await this.writeRegMask(0x1d, 0b00011000, 0b00111000);
		// [2] LNA pwr det 1 low discharge
		await this.writeRegMask(0x1c, 0b00100100, 0b00000100);
		// [4:0] LNA discharge current 13
		await this.writeRegMask(0x1e, 0b00001101, 0b00011111);
		// [5:4] AGC clock 80ms
		await this.writeRegMask(0x1a, 0b00100000, 0b00110000);
	}

	private async calibrateFilter(): Promise<number> {
		let firstTry = true;
		while (true) {
			// [6:5] filter bw manual coarse narrowest
			await this.writeRegMask(0x0b, 0b01100000, 0b01100000);
			// [2] channel filter calibration clock on
			await this.writeRegMask(0x0f, 0b00000100, 0b00000100);
			// [1:0] xtal cap setting -> no cap
			await this.writeRegMask(0x10, 0b00000000, 0b00000011);
			await this.setPll(56000000);
			if (!this.hasPllLock) throw new Error('R82xx: PLL not locked during filter calibration');
			// [4] channel filter calibration start
			await this.writeRegMask(0x0b, 0b00010000, 0b00010000);
			// [4] channel filter calibration reset
			await this.writeRegMask(0x0b, 0b00000000, 0b00010000);
			// [2] channel filter calibration clock off
			await this.writeRegMask(0x0f, 0b00000000, 0b00000100);
			const data = await this.readRegBuffer(0x00, 5);
			// [3:0] filter calibration code
			let filterCap = data[4] & 0b00001111;
			if (filterCap === 0b00001111) filterCap = 0;
			if (filterCap === 0 || !firstTry) return filterCap;
			firstTry = false;
		}
	}

	private async setMux(freq: number): Promise<void> {
		const freqMhz = freq / 1000000;
		let i: number;
		for (i = 0; i < MUX_CFGS.length - 1; i++) {
			if (freqMhz < MUX_CFGS[i + 1][0]) break;
		}
		const cfg = MUX_CFGS[i];
		// [3] open drain
		await this.writeRegMask(0x17, cfg[1], 0b00001000);
		// [7:6] tracking filter [1:0] RF filter
		await this.writeRegMask(0x1a, cfg[2], 0b11000011);
		// [7:4] LPNF [3:0] LPF
		await this.writeRegMask(0x1b, cfg[3], 0b11111111);
		// [3] xtal swing high [1:0] xtal setting no cap
		await this.writeRegMask(0x10, 0b00000000, 0b00001011);
		// [5:0] image gain 0
		await this.writeRegMask(0x08, 0b00000000, 0b00111111);
		// [5:0] image phase 0
		await this.writeRegMask(0x09, 0b00000000, 0b00111111);
	}

	private async setPll(freq: number): Promise<number> {
		const pllRef = Math.floor(this.xtalFreq);
		// [4] PLL reference divider 1:1
		await this.writeRegMask(0x10, 0b00000000, 0b00010000);
		// [3:2] PLL auto tune clock rate 128 kHz
		await this.writeRegMask(0x1a, 0b00000000, 0b00001100);
		// [7:5] VCO core power 4 (mid)
		await this.writeRegMask(0x12, 0b10000000, 0b11100000);
		let divNum = Math.min(6, Math.floor(Math.log(1770000000 / freq) / Math.LN2));
		const mixDiv = 1 << (divNum + 1);
		const data = await this.readRegBuffer(0x00, 5);
		// [5:4] VCO fine tune — compare against vcoPowerRef (2 for R820T, 1 for R828D)
		const vcoFineTune = (data[4] & 0x30) >> 4;
		if (vcoFineTune > this.vcoPowerRef) --divNum;
		else if (vcoFineTune < this.vcoPowerRef) ++divNum;
		// [7:5] pll to mixer divider
		await this.writeRegMask(0x10, divNum << 5, 0b11100000);

		const vcoFreq = freq * mixDiv;
		const nint = Math.floor(vcoFreq / (2 * pllRef));
		const vcoFra = vcoFreq % (2 * pllRef);

		if (nint > 128 / this.vcoPowerRef - 1) {
			this.hasPllLock = false;
			return 0;
		}

		const ni = Math.floor((nint - 13) / 4);
		const si = (nint - 13) % 4;
		// [7:6] si2c [5:0] ni2c
		await this.writeRegMask(0x14, ni + (si << 6), 0xff);
		// [4] sigma delta dither (0 on)
		await this.writeRegMask(0x12, vcoFra === 0 ? 0b1000 : 0b0000, 0b00001000);
		const sdm = Math.min(65535, Math.floor((32768 * vcoFra) / pllRef));
		// SDM high
		await this.writeRegMask(0x16, sdm >> 8, 0xff);
		// SDM low
		await this.writeRegMask(0x15, sdm & 0xff, 0xff);
		await this.getPllLock();
		// [3] PLL auto tune clock rate 8 kHz
		await this.writeRegMask(0x1a, 0b00001000, 0b00001000);
		return (2 * pllRef * (nint + sdm / 65536)) / mixDiv;
	}

	private async getPllLock(): Promise<void> {
		let firstTry = true;
		while (true) {
			const data = await this.readRegBuffer(0x00, 3);
			// [6] pll lock?
			if (data[2] & 0b01000000) {
				this.hasPllLock = true;
				return;
			}
			if (!firstTry) {
				// Accept after second attempt regardless (matches reference behavior)
				this.hasPllLock = true;
				return;
			}
			// [7:5] VCO core power 3
			await this.writeRegMask(0x12, 0b01100000, 0b11100000);
			firstTry = false;
		}
	}

	private async readRegBuffer(addr: number, length: number): Promise<Uint8Array> {
		const buf = await this.i2cReadBuf(addr, length);
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
		await this.i2cWrite(addr, val);
	}

	private async writeEach(cmds: Array<[number, number, number]>): Promise<void> {
		for (const [addr, value, mask] of cmds) {
			await this.writeRegMask(addr, value, mask);
		}
	}
}
