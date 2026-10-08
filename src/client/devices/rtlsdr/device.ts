import { errorMessage } from '../../platform/errors';
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

import { XTAL_FREQ, IF_FREQ, TRANSFER_BUFFER_SIZE, BLOCK, REG } from './protocol';
import { RtlCom } from './usb';
import { BIT_REVS, R820T } from './tuners/r820t';
import { FC0012 } from './tuners/fc0012';
import { E4000 } from './tuners/e4000';
import { FC0013 } from './tuners/fc0013';
import { FC2580 } from './tuners/fc2580';
import type { TunerDriver } from './tuners/types';
import { registerDriver, type SdrDevice, type SdrDeviceInfo, type GainControl } from '../../radio/sdr-device';

// ── RTL-SDR Device ────────────────────────────────────────────────
export class RtlSdrDevice implements SdrDevice {
	readonly deviceType = 'rtlsdr';
	readonly sampleRates = [250000, 1024000, 1536000, 1792000, 1920000, 2048000, 2160000, 2400000, 2560000, 2880000, 3200000];
	readonly sampleFormat = 'int8' as const;
	gainControls: GainControl[] = [
		{ name: 'Tuner', min: 0, max: 28, step: 1, default: 12, type: 'slider' },
		{ name: 'Bias-T', min: 0, max: 1, step: 1, default: 0, type: 'checkbox' },
	];

	private dev!: USBDevice;
	private com!: RtlCom;
	private tuner!: TunerDriver;
	private tunerName = '';
	private hasIfFreq = true; // R820T uses IF offset, FC0012 does not
	private conjugateIq = false; // FC0012 (zero-IF) needs spectrum inversion to match R820T
	private rxRunning: Array<Promise<void>> | null = null;
	private rxCallback: ((data: ArrayBufferView) => void) | null = null;
	private ppm = 0;
	private usbLock: Promise<void> = Promise.resolve();

	async open(device: USBDevice): Promise<void> {
		this.dev = device;
		await device.open();
		await device.selectConfiguration(1);
		console.log('RTL-SDR: device opened');

		this.com = new RtlCom(device);

		// Match charliegerard's exact init order: USB block writes BEFORE claiming interface
		await this.com.writeReg(BLOCK.USB, REG.SYSCTL, 0x09, 1);
		await this.com.writeReg(BLOCK.USB, REG.EPA_MAXPKT, 0x0200, 2);
		await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0210, 2);
		console.log('RTL-SDR: USB controller initialized');

		await device.claimInterface(0);
		console.log('RTL-SDR: interface claimed');

		// Initialize demodulator registers
		await this.com.writeReg(BLOCK.SYS, REG.DEMOD_CTL_1, 0x22, 1);
		await this.com.writeReg(BLOCK.SYS, REG.DEMOD_CTL, 0xe8, 1);
		console.log('RTL-SDR: demod control set');

		// Write demod register init sequence
		await this.com.writeDemodReg(1, 0x01, 0x14, 1);
		await this.com.writeDemodReg(1, 0x01, 0x10, 1);
		await this.com.writeDemodReg(1, 0x15, 0x00, 1);
		await this.com.writeDemodReg(1, 0x16, 0x00, 1);
		await this.com.writeDemodReg(1, 0x17, 0x00, 1);
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

		console.log('RTL-SDR: demod registers initialized');

		// Detect tuner chip by probing known I2C addresses
		const xtalFreq = Math.floor(XTAL_FREQ * (1 + this.ppm / 1000000));
		await this.com.openI2C();
		console.log('RTL-SDR: I2C opened, probing tuner addresses...');

		// Probe tuners in the same order as librtlsdr rtlsdr_open:
		// Phase 1: Probe tuners that don't need GPIO reset
		const PHASE1_PROBES: Array<{ name: string; addr: number; checkReg: number; expectVal: number; mask?: number }> = [
			{ name: 'E4000', addr: 0xc8, checkReg: 0x02, expectVal: 0x40 },
			{ name: 'FC0013', addr: 0xc6, checkReg: 0x00, expectVal: 0xa3 },
			{ name: 'R820T/R820T2/R828D', addr: 0x34, checkReg: 0x00, expectVal: 0x96 },
			{ name: 'R828D', addr: 0x74, checkReg: 0x00, expectVal: 0x96 },
		];
		// Phase 2: After GPIO5 reset — FC2580 and FC0012
		const PHASE2_PROBES: Array<{ name: string; addr: number; checkReg: number; expectVal: number; mask?: number }> = [
			{ name: 'FC2580', addr: 0xac, checkReg: 0x01, expectVal: 0x56, mask: 0x7f },
			{ name: 'FC0012', addr: 0xc6, checkReg: 0x00, expectVal: 0xa1 },
		];

		const { detectedTuner, detectedAddr }: { detectedTuner: string | null; detectedAddr: number } = await this.probeTuner(
			PHASE1_PROBES,
			PHASE2_PROBES,
		);

		if (!detectedTuner) {
			await this.com.closeI2C();
			throw new Error('RTL-SDR: No supported tuner chip found. Probed R820T, E4000, FC0012, FC0013, FC2580.');
		}

		this.tunerName = detectedTuner;
		console.log(`RTL-SDR: detected tuner: ${detectedTuner} at I2C 0x${detectedAddr.toString(16)}`);

		await this.initializeDetectedTuner(detectedAddr, xtalFreq, detectedTuner);
		await this.com.closeI2C();
		console.log('RTL-SDR: device ready');
	}

	private async initializeDetectedTuner(detectedAddr: number, xtalFreq: number, detectedTuner: string) {
		if (detectedAddr === 0x34 || detectedAddr === 0x74) {
			// R820T / R820T2 (addr 0x34) or R828D (addr 0x74)
			const isR828D = detectedAddr === 0x74;
			const isBlogV4 = isR828D && (this.dev.productName?.includes('V4') || false);
			// Blog V4 uses 28.8MHz, but standard R828D uses 16MHz clock
			const tunerFreq = isR828D && !isBlogV4 ? 16000000 : xtalFreq;

			const tunerLabel = isBlogV4 ? 'R828D (Blog V4)' : isR828D ? 'R828D' : 'R820T/R820T2';
			console.log(`RTL-SDR: initializing ${tunerLabel} (vcoPowerRef=${isR828D ? 1 : 2}, xtal=${tunerFreq})`);
			const gpioCallback = async (gpio: number, on: boolean) => {
				await this.setGpioOutput(gpio);
				await this.setGpioBit(gpio, on);
			};
			this.tuner = new R820T(this.com, tunerFreq, detectedAddr, isR828D, isBlogV4, IF_FREQ, isBlogV4 ? gpioCallback : null);
			this.hasIfFreq = true;

			// Set IF frequency offset for R82xx family.
			// The demod IF register is in the RTL2832U which always uses its own
			// 28.8 MHz clock (XTAL_FREQ), regardless of the tuner crystal.
			const multiplier = -1 * Math.floor((IF_FREQ * (1 << 22)) / xtalFreq);
			await this.com.writeDemodReg(1, 0xb1, 0x1a, 1);
			await this.com.writeDemodReg(0, 0x08, 0x4d, 1);
			await this.com.writeDemodReg(1, 0x19, (multiplier >> 16) & 0x3f, 1);
			await this.com.writeDemodReg(1, 0x1a, (multiplier >> 8) & 0xff, 1);
			await this.com.writeDemodReg(1, 0x1b, multiplier & 0xff, 1);
			await this.com.writeDemodReg(1, 0x15, 0x01, 1);
		} else if (detectedAddr === 0xc6 && detectedTuner === 'FC0013') {
			// FC0013 — zero-IF, same demod config as FC0012
			this.tuner = new FC0013(this.com, xtalFreq);
			this.hasIfFreq = false;
			this.conjugateIq = false;
			await this.setGpioOutput(6);
		} else if (detectedAddr === 0xc6) {
			// FC0012
			this.tuner = new FC0012(this.com, xtalFreq);
			this.hasIfFreq = false;
			// FC0012 is zero-IF — no spectrum conjugation needed.
			// It produces non-inverted spectrum like HackRF.
			this.conjugateIq = false;

			// FC0012 requires GPIO6 as output for V-band/U-band filter selection
			await this.setGpioOutput(6);

			// FC0012 uses zero-IF: keep init baseline demod values.
			// Do NOT apply R820T-specific registers:
			//   0xb1=0x1a (low-IF mode) — FC0012 needs 0x1b (zero-IF + IQ compensation)
			//   0x08=0x4d (R820T ADC config) — not applicable to FC0012
			//   0x15=0x01 (spectrum inversion) — FC0012 needs 0x00 (no inversion)
			// The init baseline (0xb1=0x1b, 0x15=0x00) is correct for FC0012.
		} else if (detectedAddr === 0xac) {
			// FC2580 — zero-IF tuner using internal 16.384 MHz crystal
			this.tuner = new FC2580(this.com);
			this.hasIfFreq = false;
			this.conjugateIq = false;
		} else if (detectedTuner === 'E4000') {
			// E4000 is a zero-IF tuner — same demod config as FC0012
			this.tuner = new E4000(this.com, xtalFreq);
			this.hasIfFreq = false;
			this.conjugateIq = false;
			// Zero-IF mode: use baseline demod values (0xb1=0x1b, 0x15=0x00)
		} else {
			await this.com.closeI2C();
			throw new Error(`RTL-SDR: Detected ${detectedTuner} tuner, but it is not yet supported.`);
		}

		await this.tuner.init();
		console.log(`RTL-SDR: ${detectedTuner} tuner initialized`);
		if (this.tuner.getGains) {
			const gains = this.tuner.getGains();
			if (gains.length > 0) {
				this.gainControls[0] = {
					name: 'Tuner',
					min: 0,
					max: gains.length - 1,
					step: 1,
					default: Math.min(Math.floor(gains.length / 2), gains.length - 1),
					options: gains,
					type: 'slider',
				};
			}
		}
		await this.tuner.setAutoGain();
	}

	private async probeTuner(
		PHASE1_PROBES: Array<{ name: string; addr: number; checkReg: number; expectVal: number; mask?: number }>,
		PHASE2_PROBES: Array<{ name: string; addr: number; checkReg: number; expectVal: number; mask?: number }>,
	): Promise<{ detectedTuner: string | null; detectedAddr: number }> {
		let detectedTuner: string | null = null;
		let detectedAddr = 0;

		const probeOne = async (probe: (typeof PHASE1_PROBES)[0]): Promise<boolean> => {
			try {
				await this.com.writeRegBuffer(BLOCK.I2C, probe.addr, new Uint8Array([probe.checkReg]).buffer);
				const val = await this.com.readReg(BLOCK.I2C, probe.addr, 1);
				// Bit-reverse for R820T family
				const decoded = probe.addr === 0x34 || probe.addr === 0x74 ? (BIT_REVS[val & 0xf] << 4) | BIT_REVS[val >> 4] : val;
				const checkVal = probe.mask ? decoded & probe.mask : decoded;
				console.log(
					`RTL-SDR: probe ${probe.name} (0x${probe.addr.toString(16)}): got 0x${decoded.toString(16)}, expect 0x${probe.expectVal.toString(16)}`,
				);
				if (checkVal === probe.expectVal) {
					detectedTuner = probe.name;
					detectedAddr = probe.addr;
					return true;
				}
			} catch (_) {
				console.log(`RTL-SDR: probe ${probe.name} (0x${probe.addr.toString(16)}): no response`);
			}
			return false;
		};

		// Phase 1: probe without GPIO reset
		for (const probe of PHASE1_PROBES) {
			if (await probeOne(probe)) break;
		}

		// Phase 2: GPIO5 reset then probe FC2580/FC0012
		if (!detectedTuner) {
			console.log('RTL-SDR: Phase 1 found nothing, resetting tuner via GPIO5...');
			await this.com.closeI2C();
			await this.setGpioOutput(5);
			await this.setGpioBit(5, true);
			await this.setGpioBit(5, false);
			await this.com.openI2C();

			for (const probe of PHASE2_PROBES) {
				if (await probeOne(probe)) break;
			}
		}
		return { detectedTuner, detectedAddr };
	}

	async close(): Promise<void> {
		await this.stopRx();
		try {
			await this.com.openI2C();
			await this.tuner.close();
			await this.com.closeI2C();
		} catch (_) {
			/* ignore */
		}
		try {
			await this.dev.releaseInterface(0);
		} catch (_) {
			/* ignore */
		}
		try {
			await this.dev.close();
		} catch (_) {
			/* ignore */
		}
	}

	getInfo(): Promise<SdrDeviceInfo> {
		const name = this.tunerName ? `RTL-SDR (${this.tunerName})` : 'RTL-SDR';
		const serial = this.dev.serialNumber || undefined;
		return Promise.resolve({ name, serial });
	}

	/** Serialize USB operations to prevent concurrent control/bulk transfer conflicts. */
	private withUsbLock<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.usbLock;
		let resolve!: () => void;
		this.usbLock = new Promise<void>((r) => {
			resolve = r;
		});
		return prev.then(fn).finally(resolve);
	}

	async setSampleRate(rate: number): Promise<void> {
		return await this.withUsbLock(async () => {
			await this.pauseRx();
			try {
				// Flush the Endpoint buffer since pauseRx() stopped bulk polling
				// and the FIFO rapidly overrun, wedging the ASIC.
				await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0210, 2);
				await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0000, 2);

				console.log('RTL-SDR: setSampleRate', rate);
				const xtalFreq = Math.floor(XTAL_FREQ * (1 + this.ppm / 1000000));
				let ratio = Math.floor((xtalFreq * (1 << 22)) / rate);
				ratio &= 0x0ffffffc;
				const ppmOffset = -1 * Math.floor((this.ppm * (1 << 24)) / 1000000);
				await this.com.writeDemodReg(1, 0x9f, (ratio >> 24) & 0xff, 1);
				await this.com.writeDemodReg(1, 0xa0, (ratio >> 16) & 0xff, 1);
				await this.com.writeDemodReg(1, 0xa1, (ratio >> 8) & 0xff, 1);
				await this.com.writeDemodReg(1, 0xa2, ratio & 0xff, 1);
				await this.com.writeDemodReg(1, 0x3e, (ppmOffset >> 8) & 0x3f, 1);
				await this.com.writeDemodReg(1, 0x3f, ppmOffset & 0xff, 1);
				await this.com.writeDemodReg(1, 0x01, 0x14, 1);
				await this.com.writeDemodReg(1, 0x01, 0x10, 1);
				console.log('RTL-SDR: setSampleRate complete');
			} finally {
				this.resumeRx();
			}
		});
	}

	async setFrequency(freqHz: number): Promise<void> {
		return await this.withUsbLock(async () => {
			await this.pauseRx();
			try {
				await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0210, 2);
				await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0000, 2);

				// For zero-IF tuners: re-apply demod reset cycle that setSampleRate
				// normally does. Without this, the demod's internal state (DC offset
				// tracking, I/Q balance) can be stale after the EPA flush, causing
				// the tuner to appear locked to the old frequency.
				if (!this.hasIfFreq) {
					await this.com.writeDemodReg(1, 0x01, 0x14, 1);
					await this.com.writeDemodReg(1, 0x01, 0x10, 1);
				}

				console.log('RTL-SDR: setFrequency', freqHz);
				if (this.tunerName.startsWith('FC0012')) {
					await this.setGpioBit(6, freqHz > 300000000);
				}
				await this.com.openI2C();
				await this.tuner.setFrequency(freqHz);
				await this.com.closeI2C();
			} finally {
				this.resumeRx();
			}
		});
	}

	async setGain(name: string, value: number): Promise<void> {
		return await this.setGains({ [name]: value });
	}

	async setGains(gains: Record<string, number>): Promise<void> {
		if (!this.tuner) return;
		return await this.withUsbLock(async () => {
			await this.pauseRx();
			try {
				await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0210, 2);
				await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0000, 2);

				if ('Tuner' in gains) {
					await this.com.openI2C();
					await this.tuner.setManualGain(gains['Tuner']);
					await this.com.closeI2C();
				}
				if ('Bias-T' in gains) {
					await this.setBiasTee(!!gains['Bias-T']);
				}
			} finally {
				this.resumeRx();
			}
		});
	}

	private async pauseRx(): Promise<void> {
		if (!this.rxRunning) return;
		const promises = this.rxRunning;
		this.rxRunning = null;
		// Wait for transfer loops to exit after their current readBulk completes.
		try {
			await Promise.race([Promise.allSettled(promises), new Promise<void>((r) => setTimeout(r, 500))]);
		} catch (_) {
			/* ignore */
		}
	}

	/** Restart bulk transfer loops after pauseRx. */
	private resumeRx(): void {
		if (!this.rxCallback || this.rxRunning) return;
		// Restart bulk loops in the background. This will implicitly use withUsbLock
		// to safely flush the EPA_CTL buffers and clear the WinUSB lockup from pauseRx().
		this.startRx(this.rxCallback).catch((err) => {
			console.error('RTL-SDR: Failed to resume Rx:', err);
		});
	}

	private async setGpioOutput(gpioNum: number): Promise<void> {
		// RTL2832U SYS block GPIO registers (from librtlsdr enum sys_reg):
		//   GPO  = 0x3001 (output value)
		//   GPOE = 0x3003 (output enable)
		//   GPD  = 0x3004 (direction)
		const GPO = 0x3001;
		const GPOE = 0x3003;
		const GPD = 0x3004;
		const bit = 1 << gpioNum;
		// Match librtlsdr rtlsdr_set_gpio_output:
		// 1. Read direction, clear bit in output (set pin low initially)
		const gpdVal = await this.com.readReg(BLOCK.SYS, GPD, 1);
		await this.com.writeReg(BLOCK.SYS, GPO, gpdVal & ~bit, 1);
		// 2. Enable the pin as output via GPOE
		const gpoeVal = await this.com.readReg(BLOCK.SYS, GPOE, 1);
		await this.com.writeReg(BLOCK.SYS, GPOE, gpoeVal | bit, 1);
	}

	private async setGpioBit(gpioNum: number, on: boolean): Promise<void> {
		const GPO = 0x3001;
		const gpoVal = await this.com.readReg(BLOCK.SYS, GPO, 1);
		const bit = 1 << gpioNum;
		await this.com.writeReg(BLOCK.SYS, GPO, on ? gpoVal | bit : gpoVal & ~bit, 1);
	}

	private async setBiasTee(enable: boolean): Promise<void> {
		await this.setGpioOutput(0);
		await this.setGpioBit(0, enable);
	}

	async startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		return this.withUsbLock(async () => {
			if (this.rxRunning) await this.stopRx();
			this.rxCallback = callback;

			// Reset USB buffer (matches librtlsdr rtlsdr_reset_buffer)
			await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0210, 2);
			await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0000, 2);

			this.launchBulkLoops(callback);
		});
	}

	private launchBulkLoops(callback: (data: ArrayBufferView) => void): void {
		console.log('RTL-SDR: startRx — bulk transfer loops starting');
		let rxCount = 0;
		const transfer = async (): Promise<void> => {
			await Promise.resolve();
			while (this.rxRunning) {
				try {
					const buf = await this.com.readBulk(TRANSFER_BUFFER_SIZE);
					rxCount++;
					if (rxCount <= 3) console.log(`RTL-SDR: bulk read #${rxCount}, ${buf.byteLength} bytes`);
					const uint8Data = new Uint8Array(buf);
					const int8Data = new Int8Array(uint8Data.length);
					if (this.conjugateIq) {
						for (let i = 0; i < uint8Data.length; i += 2) {
							int8Data[i] = uint8Data[i] - 128;
							int8Data[i + 1] = 128 - uint8Data[i + 1];
						}
					} else {
						for (let i = 0; i < uint8Data.length; i++) {
							int8Data[i] = uint8Data[i] - 128;
						}
					}
					callback(new Uint8Array(int8Data.buffer));
				} catch (e: unknown) {
					if (this.rxRunning) {
						const msg = e instanceof Error ? errorMessage(e) : String(e);
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
			// Wait for transfer loops to exit (they check rxRunning after each
			// readBulk completes). Use a timeout to prevent deadlocks if the
			// USB stack stalls a pending transferIn.
			try {
				await Promise.race([Promise.allSettled(promises), new Promise<void>((r) => setTimeout(r, 500))]);
			} catch (_) {
				/* ignore */
			}
		}
	}
}

// ── Register driver ───────────────────────────────────────────────
// Complete list of known RTL2832U-based device VID/PIDs (from librtlsdr)
export const RTL_SDR_FILTERS: USBDeviceFilter[] = [
	// Realtek RTL2832U
	{ vendorId: 0x0bda, productId: 0x2832 },
	// Realtek RTL2832U OEM (RTL-SDR Blog, Nooelec, etc.)
	{ vendorId: 0x0bda, productId: 0x2838 },
	// DigitalNow Quad DVB-T PCI-E card
	{ vendorId: 0x0413, productId: 0x6680 },
	// Leadtek WinFast DTV Dongle mini D
	{ vendorId: 0x0413, productId: 0x6f0f },
	// Genius TVGo DVB-T03 USB dongle (Ver. B)
	{ vendorId: 0x0458, productId: 0x707f },
	// Terratec Cinergy T Stick Black (rev 1)
	{ vendorId: 0x0ccd, productId: 0x00a9 },
	// Terratec NOXON DAB/DAB+ USB dongle (rev 1)
	{ vendorId: 0x0ccd, productId: 0x00b3 },
	// Terratec Deutschlandradio DAB Stick
	{ vendorId: 0x0ccd, productId: 0x00b4 },
	// Terratec NOXON DAB Stick - Radio Energy
	{ vendorId: 0x0ccd, productId: 0x00b5 },
	// Terratec Media Broadcast DAB Stick
	{ vendorId: 0x0ccd, productId: 0x00b7 },
	// Terratec BR DAB Stick
	{ vendorId: 0x0ccd, productId: 0x00b8 },
	// Terratec WDR DAB Stick
	{ vendorId: 0x0ccd, productId: 0x00b9 },
	// Terratec MuellerVerlag DAB Stick
	{ vendorId: 0x0ccd, productId: 0x00c0 },
	// Terratec Fraunhofer DAB Stick
	{ vendorId: 0x0ccd, productId: 0x00c6 },
	// Terratec Cinergy T Stick RC (Rev.3)
	{ vendorId: 0x0ccd, productId: 0x00d3 },
	// Terratec T Stick PLUS
	{ vendorId: 0x0ccd, productId: 0x00d7 },
	// Terratec NOXON DAB/DAB+ USB dongle (rev 2)
	{ vendorId: 0x0ccd, productId: 0x00e0 },
	// PixelView PV-DT235U(RN)
	{ vendorId: 0x1554, productId: 0x5020 },
	// Astrometa DVB-T/DVB-T2
	{ vendorId: 0x15f4, productId: 0x0131 },
	// HanfTek DAB+FM+DVB-T
	{ vendorId: 0x15f4, productId: 0x0133 },
	// Compro Videomate U620F
	{ vendorId: 0x185b, productId: 0x0620 },
	// Compro Videomate U650F
	{ vendorId: 0x185b, productId: 0x0650 },
	// Compro Videomate U680F
	{ vendorId: 0x185b, productId: 0x0680 },
	// GIGABYTE GT-U7300
	{ vendorId: 0x1b80, productId: 0xd393 },
	// DIKOM USB-DVBT HD
	{ vendorId: 0x1b80, productId: 0xd394 },
	// Peak 102569AGPK
	{ vendorId: 0x1b80, productId: 0xd395 },
	// KWorld KW-UB450-T USB DVB-T Pico TV
	{ vendorId: 0x1b80, productId: 0xd397 },
	// Zaapa ZT-MINDVBZP
	{ vendorId: 0x1b80, productId: 0xd398 },
	// SVEON STV20 DVB-T USB & FM
	{ vendorId: 0x1b80, productId: 0xd39d },
	// Twintech UT-40
	{ vendorId: 0x1b80, productId: 0xd3a4 },
	// ASUS U3100MINI_PLUS_V2
	{ vendorId: 0x1b80, productId: 0xd3a8 },
	// SVEON STV27 DVB-T USB & FM
	{ vendorId: 0x1b80, productId: 0xd3af },
	// SVEON STV21 DVB-T USB & FM
	{ vendorId: 0x1b80, productId: 0xd3b0 },
	// Dexatek DK DVB-T Dongle (Logilink VG0002A)
	{ vendorId: 0x1d19, productId: 0x1101 },
	// Dexatek DK DVB-T Dongle (MSI DigiVox mini II V3.0)
	{ vendorId: 0x1d19, productId: 0x1102 },
	// Dexatek Technology Ltd. DK 5217 DVB-T Dongle
	{ vendorId: 0x1d19, productId: 0x1103 },
	// MSI DigiVox Micro HD
	{ vendorId: 0x1d19, productId: 0x1104 },
	// Sweex DVB-T USB
	{ vendorId: 0x1f4d, productId: 0xa803 },
	// GTek T803
	{ vendorId: 0x1f4d, productId: 0xb803 },
	// Lifeview LV5TDeluxe
	{ vendorId: 0x1f4d, productId: 0xc803 },
	// MyGica TD312
	{ vendorId: 0x1f4d, productId: 0xd286 },
	// PROlectrix DV107669
	{ vendorId: 0x1f4d, productId: 0xd803 },
];

registerDriver({
	type: 'rtlsdr',
	name: 'RTL-SDR',
	filters: RTL_SDR_FILTERS,
	create: () => new RtlSdrDevice(),
});
