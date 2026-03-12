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
import { ensureWasmInitialized, init } from './wasm-init';
import { MockHackRF } from './mock-hackrf';
import {
	setRemoteHostCallback,
	setRemoteHostFftCallback,
	setRemoteHostAudioCallback,
	_ensureRemoteClients,
	_getOrCreateClientState,
	addRemoteClient,
	removeRemoteClient,
	setRemoteVfoParams,
	addRemoteVfo,
	removeRemoteVfo,
	_queueRemoteAudio,
	_mixAndEmitRemoteAudio,
	_reinitRemoteClientWorkers,
	initRemoteClient,
	feedRemoteAudioChunk,
} from './remote-clients';
import { startRxStream } from './rx-stream';
import type { VfoParams, VfoState, PerfCounters, RxStreamOpts, RemoteClientState, DeviceOpenOpts } from './types';

export class Backend {
	// Hardware
	hackrf: any;
	wasm: any;

	// VFO state
	vfoParams?: VfoParams[];
	vfoStates?: VfoState[];
	dspWorkers?: Worker[];
	ddcs?: any[];

	// Shared IQ buffers
	sharedIqPools?: (SharedArrayBuffer | ArrayBuffer)[];
	sharedIqViews?: Int8Array[];
	sabPoolIndex?: number;

	// DSP perf
	_perf?: PerfCounters;
	_perfInterval?: any;

	// Internal state
	_sampleRate?: number;
	_centerFreq?: number;
	_makeVfoState?: () => VfoState;
	_spawnWorker?: (index: number, params: VfoParams) => Worker;
	_handleWorkerAudio?: (v: number, msg: any) => void;
	_mixBuf?: Float32Array;
	_latchedSquelchOpen?: boolean[];

	// Remote client state
	_remoteHostCb?: any;
	_remoteHostFftCb?: any;
	_remoteHostAudioCb?: any;
	_remoteClients?: Map<string, RemoteClientState>;
	_remoteClientCb?: any;
	_remoteClientAudioCb?: any;

	constructor() {
	}

	async init(): Promise<void> {
		await ensureWasmInitialized();
		this.wasm = await init();
	}

	async open(opts?: DeviceOpenOpts | "mock"): Promise<boolean> {
		if (opts === "mock") {
			this.hackrf = new MockHackRF();
			await this.hackrf.open();
			return true;
		}

		const devices = await (navigator as any).usb.getDevices();
		const device = !opts ? devices[0] : devices.find((d: any) => {
			if (opts.vendorId) {
				if (d.vendorId !== opts.vendorId) {
					return false;
				}
			}
			if (opts.productId) {
				if (d.productId !== opts.productId) {
					return false;
				}
			}
			if (opts.serialNumber) {
				if (d.serialNumber !== opts.serialNumber) {
					return false;
				}
			}
			return true;
		});
		if (!device) {
			return false;
		}
		this.hackrf = new HackRF();
		await this.hackrf.open(device);
		return true;
	}

	async info(): Promise<{ boardId: number; versionString: string; apiVersion: number[]; partId: number[]; serialNo: number[] }> {
		const { hackrf } = this;
		const boardId = await hackrf.readBoardId();
		const versionString = await hackrf.readVersionString();
		const apiVersion = await hackrf.readApiVersion();
		const { partId, serialNo } = await hackrf.readPartIdSerialNo();

		const [apiMajor, apiMinor, apiSubminor] = apiVersion;
		const bcdVersion = (apiMajor << 8) | (apiMinor << 4) | apiSubminor;

		const serialStr = serialNo.map((i: number) => (i + 0x100000000).toString(16).slice(1)).join('');
		const partIdStr = partId.map((i: number) => '0x' + (i + 0x100000000).toString(16).slice(1)).join(' ');

		console.log(`Serial number: ${serialStr}`);
		console.log(`Board ID Number: ${boardId} (${HackRF.BOARD_ID_NAME.get(boardId)})`);
		console.log(`Firmware Version: ${versionString} (API:${apiMajor}.${String(apiMinor) + String(apiSubminor)})`);
		console.log(`Part ID Number: ${partIdStr}`);

		let boardRev = HackRF.BOARD_REV_UNDETECTED;
		if (bcdVersion >= 0x0106 && (boardId === 2 || boardId === 4 || boardId === 5)) {
			try {
				boardRev = await hackrf.boardRevRead();
				if (boardRev === HackRF.BOARD_REV_UNDETECTED) {
					console.log('Hardware Revision: Error: Hardware revision not yet detected by firmware.');
				} else if (boardRev === HackRF.BOARD_REV_UNRECOGNIZED) {
					console.log('Hardware Revision: Warning: Hardware revision not recognized by firmware.');
				} else {
					console.log(`Hardware Revision: ${HackRF.BOARD_REV_NAME.get(boardRev)}`);
					if (boardRev > 0) {
						if (boardRev & HackRF.HACKRF_BOARD_REV_GSG) {
							console.log('Hardware appears to have been manufactured by Great Scott Gadgets.');
						} else {
							console.log('Hardware does not appear to have been manufactured by Great Scott Gadgets.');
						}
					}
				}
			} catch (e) {
				console.warn('boardRevRead not supported:', e);
			}
		}

		if (bcdVersion >= 0x0106) {
			try {
				const platform = await hackrf.readSupportedPlatform();
				const platforms: string[] = [];
				if (platform & HackRF.HACKRF_PLATFORM_JAWBREAKER) platforms.push('Jawbreaker');
				if (platform & HackRF.HACKRF_PLATFORM_RAD1O) platforms.push('rad1o');
				if ((platform & HackRF.HACKRF_PLATFORM_HACKRF1_OG) || (platform & HackRF.HACKRF_PLATFORM_HACKRF1_R9)) platforms.push('HackRF One');
				if (platform & HackRF.HACKRF_PLATFORM_PRALINE) {
					platforms.push((boardRev & HackRF.HACKRF_BOARD_REV_GSG) ? 'HackRF Pro' : 'Praline');
				}
				console.log(`Hardware supported by installed firmware: ${platforms.join(', ')}`);
			} catch (e) {
				console.warn('readSupportedPlatform not supported:', e);
			}
		}

		try {
			const operacakes = await hackrf.getOperacakeBoards();
			for (const addr of operacakes) {
				console.log(`Opera Cake found, address: ${addr}`);
			}
		} catch (e) {
			// Opera Cake detection not supported or not present — ignore
		}

		return { boardId, versionString, apiVersion, partId, serialNo };
	}

	// Remote client methods (imported from remote-clients.ts)
	setRemoteHostCallback = setRemoteHostCallback.bind(this);
	setRemoteHostFftCallback = setRemoteHostFftCallback.bind(this);
	setRemoteHostAudioCallback = setRemoteHostAudioCallback.bind(this);
	_ensureRemoteClients = _ensureRemoteClients.bind(this);
	_getOrCreateClientState = _getOrCreateClientState.bind(this);
	addRemoteClient = addRemoteClient.bind(this);
	removeRemoteClient = removeRemoteClient.bind(this);
	setRemoteVfoParams = setRemoteVfoParams.bind(this);
	addRemoteVfo = addRemoteVfo.bind(this);
	removeRemoteVfo = removeRemoteVfo.bind(this);
	_queueRemoteAudio = _queueRemoteAudio.bind(this);
	_mixAndEmitRemoteAudio = _mixAndEmitRemoteAudio.bind(this);
	_reinitRemoteClientWorkers = _reinitRemoteClientWorkers.bind(this);
	initRemoteClient = initRemoteClient.bind(this);
	feedRemoteAudioChunk = feedRemoteAudioChunk.bind(this);

	async startRxStream(opts: RxStreamOpts, spectrumCallback: any, audioCallback: any, whisperCallback: any = null, pocsagCallback: any = null): Promise<void> {
		return startRxStream(this, opts, spectrumCallback, audioCallback, whisperCallback, pocsagCallback);
	}

	getDspStats(): any {
		if (!this._perf) return null;

		const currentSquelch = this.vfoStates ? this.vfoStates.map(s => s.squelchOpen || false) : [];
		const latchedSquelch = this._latchedSquelchOpen || [];
		const combinedSquelch = currentSquelch.map((sq, i) => sq || latchedSquelch[i]);

		this._latchedSquelchOpen = [...currentSquelch];

		return {
			...this._perf.report,
			squelchOpen: combinedSquelch,
		};
	}

	setVfoParams(index: number, params: Partial<VfoParams>): void {
		if (!this.vfoParams || index < 0 || index >= this.vfoParams.length) return;
		Object.assign(this.vfoParams[index], params);

		if (this.dspWorkers && this.dspWorkers[index]) {
			this.dspWorkers[index].postMessage({
				type: 'configure',
				params: this.vfoParams[index],
				centerFreq: this._centerFreq
			});
		}

		if (params.pocsag === false && this.vfoStates && this.vfoStates[index]) {
			this.vfoStates[index].pocsagDecoder = null;
		}
	}

	addVfo(): number {
		if (!this.vfoParams) return -1;
		const centerFreq = this._centerFreq || 100.0;
		const bw = 150000;
		const params: VfoParams = { freq: centerFreq, mode: 'wfm', enabled: false, deEmphasis: '50us', squelchEnabled: false, squelchLevel: -100.0, lowPass: true, highPass: false, bandwidth: bw, volume: 50, pocsag: false };
		this.vfoParams.push(params);

		const index = this.vfoParams.length - 1;
		this.vfoStates!.push(this._makeVfoState!());
		this.dspWorkers!.push(this._spawnWorker!(index, params));

		return index;
	}

	removeVfo(index: number): void {
		if (!this.vfoParams || index < 0 || index >= this.vfoParams.length) return;
		if (this.vfoParams.length <= 1) return;

		if (this.dspWorkers![index]) {
			this.dspWorkers![index].terminate();
		}

		this.vfoParams.splice(index, 1);
		this.dspWorkers!.splice(index, 1);
		this.vfoStates!.splice(index, 1);
	}

	async setSampleRateManual(freq: number, divider: number): Promise<void> {
		await this.hackrf.setSampleRateManual(freq, divider);
	}

	async setBasebandFilterBandwidth(bandwidthHz: number): Promise<void> {
		await this.hackrf.setBasebandFilterBandwidth(bandwidthHz);
	}

	async setLnaGain(value: number): Promise<void> {
		await this.hackrf.setLnaGain(value);
	}

	async setVgaGain(value: number): Promise<void> {
		await this.hackrf.setVgaGain(value);
	}

	async setFreq(freqHz: number): Promise<void> {
		await this.hackrf.setFreq(freqHz);
	}

	async setAmpEnable(enable: boolean): Promise<void> {
		await this.hackrf.setAmpEnable(enable);
	}

	async setAntennaEnable(enable: boolean): Promise<void> {
		await this.hackrf.setAntennaEnable(enable);
	}

	async initSweep(ranges: any, numBytes: number, stepWidth: number, offset: number, style: number): Promise<void> {
		await this.hackrf.initSweep(ranges, numBytes, stepWidth, offset, style);
	}

	async startRx(callback: any): Promise<void> {
		await this.hackrf.startRx(callback);
	}

	async startRxSweep(callback: any): Promise<void> {
		await this.hackrf.startRxSweep(callback);
	}

	async stopRx(): Promise<void> {
		await this.hackrf.stopRx();
	}

	async close(): Promise<void> {
		await this.hackrf.close();
		await this.hackrf.exit();
	}
}
