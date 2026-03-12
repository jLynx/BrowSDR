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

import { HackRF } from '../hackrf';

export class MockHackRF {
	running: boolean;
	sampleRate: number;
	centerFreq: number;
	callback: ((data: { buffer: ArrayBuffer; byteOffset: number; length: number }) => void) | null;
	phase: number;
	private thread: any;

	constructor() {
		this.running = false;
		this.sampleRate = 2000000;
		this.centerFreq = 100000000;
		this.callback = null;
		this.phase = 0;
	}
	async open(): Promise<boolean> { return true; }
	async readBoardId(): Promise<number> { return 2; }
	async readVersionString(): Promise<string> { return "Mock Firmware V1"; }
	async readApiVersion(): Promise<number[]> { return [1, 6, 0]; }
	async readPartIdSerialNo(): Promise<{ partId: number[]; serialNo: number[] }> { return { partId: [0,0], serialNo: [1,2,3,4] }; }
	async readSupportedPlatform(): Promise<number> { return HackRF.HACKRF_PLATFORM_HACKRF1_OG; }
	async boardRevRead(): Promise<number> { return 0x04 | HackRF.HACKRF_BOARD_REV_GSG; }

	async setSampleRateManual(freq: number, div: number): Promise<void> { this.sampleRate = freq / div; }
	async setBasebandFilterBandwidth(_bw: number): Promise<void> {}
	async setFreq(freq: number): Promise<void> { this.centerFreq = freq; }
	async setAmpEnable(_e: boolean): Promise<void> {}
	async setLnaGain(_g: number): Promise<void> {}
	async setVgaGain(_g: number): Promise<void> {}

	async startRx(callback: (data: { buffer: ArrayBuffer; byteOffset: number; length: number }) => void): Promise<void> {
		this.callback = callback;
		this.running = true;
		this.thread = setInterval(() => {
			if (!this.running) return;
			// Emulate USB chunk size of HackRF
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
			callback({ buffer, byteOffset: 0, length: chunkSize });
		}, ((262144 / 2) / this.sampleRate) * 1000); // Trigger at the expected sample rate
	}

	async stopRx(): Promise<void> {
		this.running = false;
		clearInterval(this.thread);
	}

	async close(): Promise<void> {}
	async exit(): Promise<void> {}
	async getOperacakeBoards(): Promise<any[]> { return []; }
}
