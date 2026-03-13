/*
Copyright (c) 2026, jLynx <https://github.com/jLynx>

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
	Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
	Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the
	documentation and/or other materials provided with the distribution.
	Neither the name of Great Scott Gadgets nor the names of its contributors may be used to endorse or promote products derived from this software
	without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import type { SdrDevice, SdrDeviceInfo, GainControl } from '../sdr-device';

export class MockHackRF implements SdrDevice {
	readonly deviceType = 'mock';
	readonly sampleRates = [2000000, 4000000, 5000000, 8000000, 10000000, 16000000, 20000000];
	readonly sampleFormat = 'int8' as const;
	readonly gainControls: GainControl[] = [
		{ name: 'LNA', min: 0, max: 40, step: 8, default: 16, type: 'slider' },
		{ name: 'VGA', min: 0, max: 62, step: 2, default: 16, type: 'slider' },
		{ name: 'Amp', min: 0, max: 1, step: 1, default: 0, type: 'checkbox' },
	];

	private running = false;
	private sampleRate = 2000000;
	private phase = 0;
	private thread: any = null;

	async open(_device?: USBDevice): Promise<void> { /* no real device */ }

	async close(): Promise<void> {
		await this.stopRx();
	}

	async getInfo(): Promise<SdrDeviceInfo> {
		return { name: 'Mock SDR (Signal Gen)', firmware: 'Mock Firmware V1' };
	}

	async setSampleRate(rate: number): Promise<void> { this.sampleRate = rate; }
	async setFrequency(_freqHz: number): Promise<void> {}
	async setGain(_name: string, _value: number): Promise<void> {}

	async startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		this.running = true;
		this.thread = setInterval(() => {
			if (!this.running) return;
			const chunkSize = 262144;
			const buffer = new ArrayBuffer(chunkSize);
			const view = new Int8Array(buffer);
			// Generate a 100 kHz tone relative to center freq + noise
			const toneFreq = 100000;
			const phaseInc = 2 * Math.PI * toneFreq / this.sampleRate;
			for (let i = 0; i < chunkSize / 2; i++) {
				this.phase += phaseInc;
				if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2;
				const i_val = Math.cos(this.phase) * 50 + (Math.random() - 0.5) * 20;
				const q_val = Math.sin(this.phase) * 50 + (Math.random() - 0.5) * 20;
				view[i * 2] = i_val;
				view[i * 2 + 1] = q_val;
			}
			callback(new Uint8Array(buffer, 0, chunkSize));
		}, ((262144 / 2) / this.sampleRate) * 1000);
	}

	async stopRx(): Promise<void> {
		this.running = false;
		if (this.thread) {
			clearInterval(this.thread);
			this.thread = null;
		}
	}
}
