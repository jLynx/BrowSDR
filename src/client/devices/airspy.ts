import { errorMessage } from '@/platform/errors';
import { AirspyIqConverter } from './airspy/iq-converter';
import { receiveTransferSize } from '@/radio/receive-transfer';
/*
Airspy WebUSB driver for BrowSDR
Copyright (c) 2026, jLynx <https://github.com/jLynx>

USB protocol reference: libairspy (BSD-3-Clause) https://github.com/airspy/airspyone_host

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

import type { SdrDevice, SdrDeviceInfo, GainControl } from '@/radio/types';
import { registerDriver } from '@/radio/sdr-device';

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
const AIRSPY_GPIO_WRITE = 21;
const AIRSPY_GET_SAMPLERATES = 25;
const AIRSPY_SET_PACKING = 26;
const TRANSFER_BUFFER_SIZE = 262144;

export class AirspyDevice implements SdrDevice {
	readonly deviceType = 'airspy';
	readonly sampleFormat = 'int8' as const;
	readonly gainControls: GainControl[] = [
		{ name: 'LNA', min: 0, max: 14, step: 1, default: 7, type: 'slider' },
		{ name: 'Mixer', min: 0, max: 15, step: 1, default: 7, type: 'slider' },
		{ name: 'VGA', min: 0, max: 15, step: 1, default: 7, type: 'slider' },
		{ name: 'Bias-T', min: 0, max: 1, step: 1, default: 0, type: 'checkbox' },
	];

	sampleRates: number[] = [2500000, 10000000];
	private firmwareRates = [10000000, 2500000];
	private sampleRate = 10000000;
	private dev!: USBDevice;
	private rxRunning: Array<Promise<void>> | null = null;

	async open(device: USBDevice): Promise<void> {
		this.dev = device;
		await device.open();
		await device.selectConfiguration(1);
		await device.claimInterface(0);
		// Closing a browser can terminate the worker without sending RECEIVER_MODE_OFF.
		// Stop inherited reception before querying or configuring the device.
		await this.vendorOut(AIRSPY_RECEIVER_MODE, 0, 0);
		await device.clearHalt('in', 1);
		// Legacy R2 firmware uses this same fallback order in libairspy.
		this.firmwareRates = [10000000, 2500000];
		try {
			const countBuf = await this.vendorIn(AIRSPY_GET_SAMPLERATES, 0, 0, 4);
			const count = new DataView(countBuf).getUint32(0, true);
			if (count < 1 || count > 99) throw new Error('Airspy: invalid sample rate count');
			const ratesBuf = await this.vendorIn(AIRSPY_GET_SAMPLERATES, 0, count, count * 4);
			const ratesView = new DataView(ratesBuf);
			const rates = Array.from({ length: count }, (_, i) => ratesView.getUint32(i * 4, true));
			if (rates.some((rate) => rate === 0)) throw new Error('Airspy: invalid sample rate');
			this.firmwareRates = rates;
		} catch (e) {
			console.warn('Airspy: could not query sample rates, using R2 defaults', e);
		}
		// Sort only the UI list; SET_SAMPLERATE indexes the firmware's original list.
		this.sampleRates = [...this.firmwareRates].sort((a, b) => a - b);
	}

	async close(): Promise<void> {
		await this.stopRx();
		await this.dev.close();
	}

	async getInfo(): Promise<SdrDeviceInfo> {
		let name = 'Airspy';
		let firmware: string | undefined;
		let serial: string | undefined;
		try {
			const board = await this.vendorIn(AIRSPY_BOARD_ID_READ, 0, 0, 1);
			// R2 and Mini share board ID 0; it does not distinguish models.
			if (new DataView(board).getUint8(0) === 0) name = 'Airspy One';
		} catch (_) {
			/* optional metadata */
		}
		try {
			const version = await this.vendorIn(AIRSPY_VERSION_STRING_READ, 0, 0, 127);
			firmware = String.fromCharCode(...new Uint8Array(version).filter((byte) => byte !== 0));
		} catch (_) {
			/* optional metadata */
		}
		try {
			const serialBuf = await this.vendorIn(AIRSPY_BOARD_PARTID_SERIALNO_READ, 0, 0, 24);
			const view = new DataView(serialBuf);
			serial = [8, 12, 16, 20].map((offset) => view.getUint32(offset, true).toString(16).padStart(8, '0')).join('');
		} catch (_) {
			/* optional metadata */
		}
		return { name, serial, firmware };
	}

	async setSampleRate(rate: number): Promise<void> {
		const index = this.firmwareRates.indexOf(rate);
		if (index < 0) throw new Error(`Airspy: unsupported sample rate ${rate}`);
		await this.stopRx();
		await this.dev.clearHalt('in', 1);
		await this.vendorIn(AIRSPY_SET_SAMPLERATE, 0, index, 1);
		this.sampleRate = rate;
	}

	async setFrequency(freqHz: number): Promise<void> {
		const data = new ArrayBuffer(4);
		new DataView(data).setUint32(0, freqHz, true);
		await this.vendorOut(AIRSPY_SET_FREQ, 0, 0, data);
	}

	async setGain(name: string, value: number): Promise<void> {
		const gain = Math.max(0, Math.min(name === 'LNA' ? 14 : 15, Math.round(value)));
		switch (name) {
			case 'LNA':
				await this.vendorIn(AIRSPY_SET_LNA_AGC, 0, 0, 1);
				await this.vendorIn(AIRSPY_SET_LNA_GAIN, 0, gain, 1);
				break;
			case 'Mixer':
				await this.vendorIn(AIRSPY_SET_MIXER_AGC, 0, 0, 1);
				await this.vendorIn(AIRSPY_SET_MIXER_GAIN, 0, gain, 1);
				break;
			case 'VGA':
				await this.vendorIn(AIRSPY_SET_VGA_GAIN, 0, gain, 1);
				break;
			case 'Bias-T':
				await this.vendorOut(AIRSPY_GPIO_WRITE, value ? 1 : 0, (1 << 5) | 13);
				break;
		}
	}

	async startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		if (this.rxRunning) await this.stopRx();
		await this.vendorOut(AIRSPY_RECEIVER_MODE, 0, 0);
		// Do not guess the format retained by a previously used native application.
		await this.vendorIn(AIRSPY_SET_PACKING, 0, 0, 1);
		await this.dev.clearHalt('in', 1);
		await this.vendorOut(AIRSPY_RECEIVER_MODE, 1, 0);
		const session: Array<Promise<void>> = [];
		this.rxRunning = session;
		session.push(this.receive(session, callback));
	}

	private async receive(session: Array<Promise<void>>, callback: (data: ArrayBufferView) => void): Promise<void> {
		const converter = new AirspyIqConverter();
		// Each IQ sample comes from two unpacked 16-bit real ADC samples.
		const transferSize = receiveTransferSize(this.sampleRate, TRANSFER_BUFFER_SIZE, 4);
		// Submit several reads, but consume in submission order: the converter is stateful.
		// Catch each queued rejection immediately, even if an earlier read is pending.
		const read = (): Promise<USBInTransferResult | Error> =>
			this.dev.transferIn(1, transferSize).catch((error: unknown) => new Error(errorMessage(error)));
		const pending = Array.from({ length: 4 }, read);
		try {
			while (this.rxRunning === session) {
				const result = await pending.shift()!;
				if (this.rxRunning !== session) break;
				if (result instanceof Error) throw result;
				if (result.status !== 'ok' || !result.data) throw new Error(`Airspy: bulk IN failed (${result.status})`);
				pending.push(read());
				const iq = converter.process(result.data);
				if (iq.length) callback(iq);
			}
		} catch (e: unknown) {
			if (this.rxRunning === session) {
				console.error('Airspy: transfer error:', errorMessage(e));
				await this.vendorOut(AIRSPY_RECEIVER_MODE, 0, 0).catch(() => {});
			}
		} finally {
			await Promise.allSettled(pending);
		}
	}

	async stopRx(): Promise<void> {
		const session = this.rxRunning;
		this.rxRunning = null;
		// Turn off before draining reads, and discard any completion from this session.
		await this.vendorOut(AIRSPY_RECEIVER_MODE, 0, 0).catch(() => {});
		if (!session) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const drained = await Promise.race([
				Promise.allSettled(session).then(() => true),
				new Promise<false>((resolve) => {
					timer = setTimeout(() => resolve(false), 1000);
				}),
			]);
			if (!drained) {
				// WebUSB cannot cancel individual reads; closing cancels all queued reads.
				await this.dev.close();
				await Promise.allSettled(session);
				await this.dev.open();
				await this.dev.selectConfiguration(1);
				await this.dev.claimInterface(0);
			}
		} finally {
			clearTimeout(timer);
		}
	}

	private async vendorOut(request: number, value: number, index: number, data?: ArrayBuffer): Promise<void> {
		const result = await this.dev
			.controlTransferOut({ requestType: 'vendor', recipient: 'device', request, value, index }, data)
			.catch((error: unknown) => {
				throw new Error(`Airspy: vendor OUT failed (req=${request}, value=${value}, index=${index}): ${errorMessage(error)}`);
			});
		if (result.status !== 'ok') throw new Error(`Airspy: vendor OUT failed (req=${request})`);
	}

	private async vendorIn(request: number, value: number, index: number, length: number): Promise<ArrayBuffer> {
		const result = await this.dev
			.controlTransferIn({ requestType: 'vendor', recipient: 'device', request, value, index }, length)
			.catch((error: unknown) => {
				throw new Error(`Airspy: vendor IN failed (req=${request}, value=${value}, index=${index}): ${errorMessage(error)}`);
			});
		if (result.status !== 'ok' || !result.data) throw new Error(`Airspy: vendor IN failed (req=${request})`);
		const data = result.data;
		if (request !== AIRSPY_VERSION_STRING_READ && data.byteLength !== length) {
			throw new Error(`Airspy: short vendor IN (req=${request}, got=${data.byteLength}, expected=${length})`);
		}
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
	}
}

registerDriver({
	type: 'airspy',
	name: 'Airspy',
	filters: [{ vendorId: 0x1d50, productId: 0x60a1 }],
	create: () => new AirspyDevice(),
});
