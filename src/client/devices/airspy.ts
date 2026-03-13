/*
Airspy WebUSB driver for BrowSDR
Copyright (c) 2026, jLynx <https://github.com/jLynx>

Based on libairspy (Apache 2.0) https://github.com/airspy/airspyone_host

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

import type { SdrDevice, SdrDeviceInfo, GainControl } from '../sdr-device';
import { registerDriver } from '../sdr-device';

// ── Airspy vendor request codes ───────────────────────────────────
const AIRSPY_RECEIVER_MODE = 1;
const AIRSPY_BOARD_ID_READ = 9;
const AIRSPY_VERSION_STRING_READ = 10;
const AIRSPY_BOARD_PARTID_SERIALNO_READ = 11;
const AIRSPY_SET_SAMPLERATE = 12;
const AIRSPY_SET_FREQ = 13;
const AIRSPY_SET_LNA_GAIN = 14;
const AIRSPY_SET_MIXER_GAIN = 15;
const AIRSPY_SET_VGA_GAIN = 16;
const AIRSPY_SET_LNA_AGC = 17;
const AIRSPY_SET_MIXER_AGC = 18;
const AIRSPY_SET_RF_BIAS_CMD = 20;
const AIRSPY_GET_SAMPLERATES = 25;

const TRANSFER_BUFFER_SIZE = 65536;

export class AirspyDevice implements SdrDevice {
	readonly deviceType = 'airspy';
	readonly sampleFormat = 'int16' as const;
	readonly gainControls: GainControl[] = [
		{ name: 'LNA', min: 0, max: 14, step: 1, default: 7, type: 'slider' },
		{ name: 'Mixer', min: 0, max: 15, step: 1, default: 7, type: 'slider' },
		{ name: 'VGA', min: 0, max: 15, step: 1, default: 7, type: 'slider' },
		{ name: 'Bias-T', min: 0, max: 1, step: 1, default: 0, type: 'checkbox' },
	];

	// Populated during open() from device query
	sampleRates: number[] = [3000000, 6000000, 10000000];

	private dev!: USBDevice;
	private rxRunning: Promise<void>[] | null = null;

	async open(device: USBDevice): Promise<void> {
		this.dev = device;
		await device.open();
		await device.selectConfiguration(1);
		await device.claimInterface(0);

		// Query supported sample rates
		try {
			const countBuf = await this.vendorIn(AIRSPY_GET_SAMPLERATES, 0, 0, 4);
			const count = new DataView(countBuf).getUint32(0, true);
			if (count > 0 && count < 100) {
				const ratesBuf = await this.vendorIn(AIRSPY_GET_SAMPLERATES, 0, count, count * 4);
				const ratesView = new DataView(ratesBuf);
				this.sampleRates = [];
				for (let i = 0; i < count; i++) {
					this.sampleRates.push(ratesView.getUint32(i * 4, true));
				}
				this.sampleRates.sort((a, b) => a - b);
			}
		} catch (e) {
			console.warn('Airspy: could not query sample rates, using defaults', e);
		}
	}

	async close(): Promise<void> {
		await this.stopRx();
		try {
			await this.vendorOut(AIRSPY_RECEIVER_MODE, 0, 0);
		} catch (_) { /* ignore */ }
		try { await this.dev.close(); } catch (_) { /* ignore */ }
	}

	async getInfo(): Promise<SdrDeviceInfo> {
		let name = 'Airspy';
		let firmware: string | undefined;
		let serial: string | undefined;

		try {
			const boardBuf = await this.vendorIn(AIRSPY_BOARD_ID_READ, 0, 0, 4);
			const boardId = new DataView(boardBuf).getUint32(0, true);
			if (boardId === 0) name = 'Airspy One';
			else if (boardId === 1) name = 'Airspy Mini';
			else if (boardId === 2) name = 'Airspy R2';
		} catch (_) { /* ignore */ }

		try {
			const verBuf = await this.vendorIn(AIRSPY_VERSION_STRING_READ, 0, 0, 128);
			firmware = String.fromCharCode(...new Uint8Array(verBuf).filter(b => b !== 0));
		} catch (_) { /* ignore */ }

		try {
			const serialBuf = await this.vendorIn(AIRSPY_BOARD_PARTID_SERIALNO_READ, 0, 0, 24);
			const dv = new DataView(serialBuf);
			const sn = [dv.getUint32(8, true), dv.getUint32(12, true), dv.getUint32(16, true), dv.getUint32(20, true)];
			serial = sn.map(n => (n + 0x100000000).toString(16).slice(1)).join('');
		} catch (_) { /* ignore */ }

		return { name, serial, firmware };
	}

	async setSampleRate(rate: number): Promise<void> {
		// Airspy takes a sample rate index or direct value
		const data = new ArrayBuffer(4);
		new DataView(data).setUint32(0, rate, true);
		await this.vendorOut(AIRSPY_SET_SAMPLERATE, 0, 0, data);
	}

	async setFrequency(freqHz: number): Promise<void> {
		const data = new ArrayBuffer(4);
		new DataView(data).setUint32(0, freqHz, true);
		await this.vendorOut(AIRSPY_SET_FREQ, 0, 0, data);
	}

	async setGain(name: string, value: number): Promise<void> {
		switch (name) {
			case 'LNA':
				await this.vendorOut(AIRSPY_SET_LNA_AGC, 0, 0); // Disable AGC
				await this.vendorOut(AIRSPY_SET_LNA_GAIN, 0, value & 0x0f);
				break;
			case 'Mixer':
				await this.vendorOut(AIRSPY_SET_MIXER_AGC, 0, 0); // Disable AGC
				await this.vendorOut(AIRSPY_SET_MIXER_GAIN, 0, value & 0x0f);
				break;
			case 'VGA':
				await this.vendorOut(AIRSPY_SET_VGA_GAIN, 0, value & 0x0f);
				break;
			case 'Bias-T':
				await this.vendorOut(AIRSPY_SET_RF_BIAS_CMD, 0, value ? 1 : 0);
				break;
		}
	}

	async startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		if (this.rxRunning) await this.stopRx();

		// Enable receiver
		await this.vendorOut(AIRSPY_RECEIVER_MODE, 1, 0);

		const transfer = async (): Promise<void> => {
			await Promise.resolve();
			while (this.rxRunning) {
				try {
					const result = await this.dev.transferIn(1, TRANSFER_BUFFER_SIZE);
					if (result.status !== 'ok') break;
					const raw = new Uint8Array(result.data!.buffer, 0, result.data!.byteLength);

					// Airspy sends 12-bit samples packed in 16-bit LE words
					// Convert to int8 IQ for the DSP pipeline
					const int16View = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
					const int8Data = new Int8Array(int16View.length);
					for (let i = 0; i < int16View.length; i++) {
						// Scale 12-bit signed (-2048..2047) to int8 (-128..127)
						int8Data[i] = int16View[i] >> 4;
					}
					callback(new Uint8Array(int8Data.buffer));
				} catch (e: unknown) {
					if (this.rxRunning) {
						const msg = e instanceof Error ? e.message : String(e);
						console.error('Airspy: transfer error:', msg);
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
			try { await Promise.allSettled(promises); } catch (_) { /* ignore */ }
		}
		try {
			await this.vendorOut(AIRSPY_RECEIVER_MODE, 0, 0);
		} catch (_) { /* ignore */ }
	}

	// ── USB helper methods ────────────────────────────────────────
	private async vendorOut(request: number, value: number, index: number, data?: ArrayBuffer): Promise<void> {
		const result = await this.dev.controlTransferOut({
			requestType: 'vendor',
			recipient: 'device',
			request,
			value,
			index,
		}, data);
		if (result.status !== 'ok') throw new Error(`Airspy: vendor OUT failed (req=${request})`);
	}

	private async vendorIn(request: number, value: number, index: number, length: number): Promise<ArrayBuffer> {
		const result = await this.dev.controlTransferIn({
			requestType: 'vendor',
			recipient: 'device',
			request,
			value,
			index,
		}, length);
		if (result.status !== 'ok') throw new Error(`Airspy: vendor IN failed (req=${request})`);
		return new Uint8Array(result.data!.buffer).buffer as ArrayBuffer;
	}
}

// ── Register driver ───────────────────────────────────────────────
registerDriver({
	type: 'airspy',
	name: 'Airspy',
	filters: [{ vendorId: 0x1d50, productId: 0x60a1 }],
	create: () => new AirspyDevice(),
});
