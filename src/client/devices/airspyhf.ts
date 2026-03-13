/*
Airspy HF+ WebUSB driver for BrowSDR
Copyright (c) 2026, jLynx <https://github.com/jLynx>

Based on libairspyhf (Apache 2.0) https://github.com/airspy/airspyhf

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

// ── Airspy HF+ vendor request codes ──────────────────────────────
const AIRSPYHF_RECEIVER_MODE = 1;
const AIRSPYHF_SET_FREQ = 2;
const AIRSPYHF_GET_SAMPLERATES = 3;
const AIRSPYHF_SET_SAMPLERATE = 4;
const AIRSPYHF_GET_SERIALNO_BOARDID = 7;
const AIRSPYHF_GET_VERSION_STRING = 9;
const AIRSPYHF_SET_AGC = 10;
const AIRSPYHF_SET_AGC_THRESHOLD = 11;
const AIRSPYHF_SET_ATT = 12;
const AIRSPYHF_SET_LNA = 13;

const TRANSFER_BUFFER_SIZE = 65536;

const BOARD_NAMES: Record<number, string> = {
	0: 'Airspy HF+',
	1: 'Airspy HF+ Rev A',
	2: 'Airspy HF+ Discovery',
	3: 'Airspy HF+ Ranger',
};

export class AirspyHfDevice implements SdrDevice {
	readonly deviceType = 'airspyhf';
	readonly sampleFormat = 'float32' as const;
	readonly gainControls: GainControl[] = [
		{ name: 'Attenuation', min: 0, max: 48, step: 6, default: 0, type: 'slider' },
		{ name: 'HF AGC', min: 0, max: 1, step: 1, default: 1, type: 'checkbox' },
		{ name: 'HF LNA', min: 0, max: 1, step: 1, default: 0, type: 'checkbox' },
	];

	// Populated during open() from device query
	sampleRates: number[] = [192000, 256000, 384000, 456000, 768000, 912000];

	private dev!: USBDevice;
	private rxRunning: Promise<void>[] | null = null;

	async open(device: USBDevice): Promise<void> {
		this.dev = device;
		await device.open();
		await device.selectConfiguration(1);
		await device.claimInterface(0);

		// Query supported sample rates
		try {
			const countBuf = await this.vendorIn(AIRSPYHF_GET_SAMPLERATES, 0, 0, 4);
			const count = new DataView(countBuf).getUint32(0, true);
			if (count > 0 && count < 100) {
				const ratesBuf = await this.vendorIn(AIRSPYHF_GET_SAMPLERATES, 0, count, count * 4);
				const ratesView = new DataView(ratesBuf);
				this.sampleRates = [];
				for (let i = 0; i < count; i++) {
					this.sampleRates.push(ratesView.getUint32(i * 4, true));
				}
				this.sampleRates.sort((a, b) => a - b);
			}
		} catch (e) {
			console.warn('AirspyHF: could not query sample rates, using defaults', e);
		}
	}

	async close(): Promise<void> {
		await this.stopRx();
		try {
			await this.vendorOut(AIRSPYHF_RECEIVER_MODE, 0, 0);
		} catch (_) { /* ignore */ }
		try { await this.dev.close(); } catch (_) { /* ignore */ }
	}

	async getInfo(): Promise<SdrDeviceInfo> {
		let name = 'Airspy HF+';
		let firmware: string | undefined;
		let serial: string | undefined;

		try {
			const infoBuf = await this.vendorIn(AIRSPYHF_GET_SERIALNO_BOARDID, 0, 0, 12);
			const dv = new DataView(infoBuf);
			const sn = dv.getBigUint64(0, true);
			serial = sn.toString(16).padStart(16, '0');
			const boardId = dv.getUint16(8, true);
			name = BOARD_NAMES[boardId] || `Airspy HF+ (ID ${boardId})`;
		} catch (_) { /* ignore */ }

		try {
			const verBuf = await this.vendorIn(AIRSPYHF_GET_VERSION_STRING, 0, 0, 128);
			firmware = String.fromCharCode(...new Uint8Array(verBuf).filter(b => b !== 0));
		} catch (_) { /* ignore */ }

		return { name, serial, firmware };
	}

	async setSampleRate(rate: number): Promise<void> {
		const data = new ArrayBuffer(4);
		new DataView(data).setUint32(0, rate, true);
		await this.vendorOut(AIRSPYHF_SET_SAMPLERATE, 0, 0, data);
	}

	async setFrequency(freqHz: number): Promise<void> {
		// Airspy HF+ takes 64-bit frequency in some firmware versions,
		// but for simplicity we split into two 32-bit values via value/index
		const lo = freqHz & 0xffffffff;
		const hi = Math.floor(freqHz / 0x100000000) & 0xffffffff;
		const data = new ArrayBuffer(8);
		const dv = new DataView(data);
		dv.setUint32(0, lo, true);
		dv.setUint32(4, hi, true);
		await this.vendorOut(AIRSPYHF_SET_FREQ, 0, 0, data);
	}

	async setGain(name: string, value: number): Promise<void> {
		switch (name) {
			case 'Attenuation':
				await this.vendorOut(AIRSPYHF_SET_ATT, 0, value);
				break;
			case 'HF AGC':
				await this.vendorOut(AIRSPYHF_SET_AGC, 0, value ? 1 : 0);
				if (value) {
					// Default AGC threshold to low
					await this.vendorOut(AIRSPYHF_SET_AGC_THRESHOLD, 0, 0);
				}
				break;
			case 'HF LNA':
				await this.vendorOut(AIRSPYHF_SET_LNA, 0, value ? 1 : 0);
				break;
		}
	}

	async startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		if (this.rxRunning) await this.stopRx();

		// Enable receiver
		await this.vendorOut(AIRSPYHF_RECEIVER_MODE, 1, 0);

		const transfer = async (): Promise<void> => {
			await Promise.resolve();
			while (this.rxRunning) {
				try {
					const result = await this.dev.transferIn(1, TRANSFER_BUFFER_SIZE);
					if (result.status !== 'ok') break;
					const raw = new Uint8Array(result.data!.buffer, 0, result.data!.byteLength);

					// Airspy HF+ sends complex float32 IQ pairs
					// Convert to int8 IQ for the DSP pipeline
					const floatView = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
					const int8Data = new Int8Array(floatView.length);
					for (let i = 0; i < floatView.length; i++) {
						// Float range is typically -1.0 to 1.0, scale to int8
						let val = Math.round(floatView[i] * 127);
						if (val > 127) val = 127;
						else if (val < -128) val = -128;
						int8Data[i] = val;
					}
					callback(new Uint8Array(int8Data.buffer));
				} catch (e: unknown) {
					if (this.rxRunning) {
						const msg = e instanceof Error ? e.message : String(e);
						console.error('AirspyHF: transfer error:', msg);
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
			await this.vendorOut(AIRSPYHF_RECEIVER_MODE, 0, 0);
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
		if (result.status !== 'ok') throw new Error(`AirspyHF: vendor OUT failed (req=${request})`);
	}

	private async vendorIn(request: number, value: number, index: number, length: number): Promise<ArrayBuffer> {
		const result = await this.dev.controlTransferIn({
			requestType: 'vendor',
			recipient: 'device',
			request,
			value,
			index,
		}, length);
		if (result.status !== 'ok') throw new Error(`AirspyHF: vendor IN failed (req=${request})`);
		return new Uint8Array(result.data!.buffer).buffer as ArrayBuffer;
	}
}

// ── Register driver ───────────────────────────────────────────────
registerDriver({
	type: 'airspyhf',
	name: 'Airspy HF+',
	filters: [{ vendorId: 0x03eb, productId: 0x800c }],
	create: () => new AirspyHfDevice(),
});
