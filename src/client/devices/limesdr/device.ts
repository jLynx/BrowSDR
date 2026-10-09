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
		{ name: 'USB Format', min: 0, max: 1, step: 1, default: 0, labels: ['16-bit', 'Packed 12-bit'], type: 'select' },
		...(import.meta.env.DEV
			? [
					{
						name: 'Receive Mode',
						min: 0,
						max: 1,
						step: 1,
						default: 0,
						labels: ['Normal', 'USB only (diagnostic)'],
						type: 'select',
					} as GainControl,
				]
			: []),
	];

	private lime = new LimeSDR();
	getRxLevel() {
		return this.lime.rxLevel.level;
	}
	getRxStreamStats() {
		return this.lime.streamStats.report;
	}
	private operationQueue: Promise<void> = Promise.resolve();
	private rxCallback: ((data: ArrayBufferView) => void) | null = null;
	private gains: Record<string, number> = { 'RX Channel': 0, LNA: 14, TIA: 2, PGA: 16, Antenna: 1, 'USB Format': 0, 'Receive Mode': 0 };

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

	private async applyRfGains(gains: Record<string, number>): Promise<void> {
		for (const [name, value] of Object.entries(gains)) {
			if (name !== 'RX Channel' && name !== 'USB Format' && name !== 'Receive Mode') await this.applyGain(name, value);
		}
	}

	private async restoreReceiveConfig(gains: Record<string, number>, callback: ((data: ArrayBufferView) => void) | null) {
		await this.lime.stopStreaming();
		this.lime.setLinkFormat(gains['USB Format'] === 1 ? 12 : 16);
		await this.lime.setRxChannel(gains['RX Channel']);
		await this.applyRfGains(gains);
		if (callback) await this.startReceive(callback, gains);
	}

	private validateReceiveConfig(next: Record<string, number>, previous: Record<string, number>): void {
		if (next['RX Channel'] !== 0 && next['RX Channel'] !== 1) throw new Error(`LimeSDR: unsupported RX channel ${next['RX Channel']}`);
		if (next['USB Format'] !== 0 && next['USB Format'] !== 1) throw new Error('LimeSDR: unsupported USB format');
		if (next['Receive Mode'] !== 0 && next['Receive Mode'] !== 1) throw new Error('LimeSDR: unsupported receive mode');
		if (!import.meta.env.DEV && next['Receive Mode'] === 1) throw new Error('LimeSDR: USB-only reception requires a development build');
		if (this.rxCallback && next['Receive Mode'] !== previous['Receive Mode'])
			throw new Error('LimeSDR: stop reception before changing receive mode');
	}

	async setGains(gains: Record<string, number>): Promise<void> {
		await this.runExclusive(async () => {
			const previous = this.gains;
			const next = { ...previous, ...gains };
			const channel = next['RX Channel'];
			this.validateReceiveConfig(next, previous);
			const switching = channel !== previous['RX Channel'];
			const changingFormat = next['USB Format'] !== previous['USB Format'];
			const callback = switching || changingFormat ? this.rxCallback : null;
			try {
				if (callback) await this.lime.stopStreaming();
				if (switching) await this.lime.setRxChannel(channel);
				if (changingFormat) this.lime.setLinkFormat(next['USB Format'] === 1 ? 12 : 16);
				await this.applyRfGains(switching ? next : gains);
				if (callback) await this.startReceive(callback, next);
				this.gains = next;
			} catch (error) {
				if (switching || changingFormat) {
					try {
						await this.restoreReceiveConfig(previous, callback);
					} catch (recoveryError) {
						console.error('LimeSDR: failed to restore previous receiver', recoveryError);
					}
				}
				throw error;
			}
		});
	}

	private async startReceive(callback: (data: ArrayBufferView) => void, gains = this.gains): Promise<void> {
		if (gains['Receive Mode'] === 1) await this.lime.startStreaming(callback, true);
		else await this.lime.startStreaming(callback);
	}

	async startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		await this.runExclusive(async () => {
			await this.startReceive(callback);
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
