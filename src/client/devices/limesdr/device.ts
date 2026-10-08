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

import { LimeSDR } from './driver';
import { MAX_SAMPLE_RATE } from './protocol';
import { registerDriver } from '@/radio/sdr-device';
import type { SdrDevice, SdrDeviceInfo, GainControl } from '@/radio/types';
// ── LimeSDRDevice (SdrDevice wrapper) ───────────────────────────────

export class LimeSDRDevice implements SdrDevice {
	readonly deviceType = 'limesdr';
	readonly sampleRates = [1e6, 2e6, 5e6, 10e6, 20e6, 30.72e6, 40e6, 50e6, MAX_SAMPLE_RATE];
	readonly sampleFormat = 'int8' as const;
	readonly gainControls: GainControl[] = [
		{ name: 'RX Channel', min: 0, max: 1, step: 1, default: 0, labels: ['RX1', 'RX2'], type: 'select' },
		{ name: 'LNA', min: 0, max: 30, step: 1, default: 14, type: 'slider' },
		{ name: 'TIA', min: 0, max: 2, step: 1, default: 2, labels: ['0 dB', '9 dB', '12 dB'], type: 'select' },
		{ name: 'PGA', min: 0, max: 31, step: 1, default: 16, type: 'slider' },
		{ name: 'Antenna', min: 0, max: 2, step: 1, default: 1, labels: ['LNAH', 'LNAL', 'LNAW'], type: 'select' },
	];

	private lime = new LimeSDR();
	getRxLevel() {
		return this.lime.rxLevel.level;
	}
	private operationQueue: Promise<void> = Promise.resolve();
	private rxCallback: ((data: ArrayBufferView) => void) | null = null;
	private gains: Record<string, number> = { 'RX Channel': 0, LNA: 14, TIA: 2, PGA: 16, Antenna: 1 };

	private runExclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
		const result = this.operationQueue.then(operation);
		this.operationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async open(device: USBDevice): Promise<void> {
		await this.lime.open(device);
		try {
			await this.lime.initialize();
		} catch (error) {
			await this.lime.close();
			throw error;
		}
	}

	async close(): Promise<void> {
		await this.runExclusive(async () => {
			this.rxCallback = null;
			await this.lime.close();
		});
	}

	async getInfo(): Promise<SdrDeviceInfo> {
		return this.lime.getDeviceInfo();
	}

	async setSampleRate(rate: number): Promise<void> {
		await this.runExclusive(() => this.lime.setSampleRate(rate));
	}

	async setFrequency(freqHz: number): Promise<void> {
		await this.runExclusive(() => this.lime.setFrequencySXR(freqHz));
	}

	async setGain(name: string, value: number): Promise<void> {
		await this.setGains({ [name]: value });
	}

	private async applyGain(name: string, value: number): Promise<void> {
		switch (name) {
			case 'LNA':
				await this.lime.setLNAGain(value);
				break;
			case 'TIA':
				await this.lime.setTIAGain(value);
				break;
			case 'PGA':
				await this.lime.setPGAGain(value);
				break;
			case 'Antenna':
				await this.lime.setAntennaPath(value);
				break;
			default:
				console.warn(`LimeSDR: unknown gain "${name}"`);
		}
	}

	async setGains(gains: Record<string, number>): Promise<void> {
		await this.runExclusive(async () => {
			const previous = this.gains;
			const next = { ...previous, ...gains };
			const channel = next['RX Channel'];
			if (channel !== 0 && channel !== 1) throw new Error(`LimeSDR: unsupported RX channel ${channel}`);
			const switching = channel !== previous['RX Channel'];
			const callback = switching ? this.rxCallback : null;
			try {
				if (callback) await this.lime.stopStreaming();
				if (switching) await this.lime.setRxChannel(channel);
				for (const [name, value] of Object.entries(switching ? next : gains)) {
					if (name !== 'RX Channel') await this.applyGain(name, value);
				}
				if (callback) await this.lime.startStreaming(callback);
				this.gains = next;
			} catch (error) {
				if (switching) {
					try {
						await this.lime.setRxChannel(previous['RX Channel']);
						for (const [name, value] of Object.entries(previous)) {
							if (name !== 'RX Channel') await this.applyGain(name, value);
						}
						if (callback) await this.lime.startStreaming(callback);
					} catch (recoveryError) {
						console.error('LimeSDR: failed to restore previous receiver', recoveryError);
					}
				}
				throw error;
			}
		});
	}

	async startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		await this.runExclusive(async () => {
			await this.lime.startStreaming(callback);
			this.rxCallback = callback;
		});
	}

	async stopRx(): Promise<void> {
		await this.runExclusive(async () => {
			this.rxCallback = null;
			await this.lime.stopStreaming();
		});
	}
}

// ── Driver Registration ─────────────────────────────────────────────

const LIMESDR_FILTERS: USBDeviceFilter[] = [
	{ vendorId: 0x04b4, productId: 0x00f1 }, // Cypress FX3 (LimeSDR-USB)
	{ vendorId: 0x0403, productId: 0x601f }, // FTDI
	{ vendorId: 0x1d50, productId: 0x6108 }, // Myriad-RF
];

registerDriver({
	type: 'limesdr',
	name: 'LimeSDR-USB',
	filters: LIMESDR_FILTERS,
	create: () => new LimeSDRDevice(),
});
