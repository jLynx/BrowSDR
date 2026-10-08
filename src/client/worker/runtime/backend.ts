import type {
	SamplesCallback,
	AudioCallback,
	WhisperCallback,
	PocsagCallback,
	RdsCallback,
	Rtl433Callback,
	DsdCallback,
	HostCallback,
	HostStats,
} from '@/worker/runtime/callbacks.types';
import type { DspAudio } from '@/worker/runtime/dsp-messages.types';
import type { InitOutput, DspProcessor } from '/hackrf-web/pkg/hackrf_web.js';
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

import { ensureWasmInitialized, init } from './wasm-init';
import { normalizeSpectrumFps } from '@/display/spectrum-rate';
import { MockHackRF } from './mock-hackrf';
import type { SdrDevice, SdrDeviceInfo, DeviceCapabilities } from '@/radio/types';
import { detectDevice } from '@/radio/sdr-device';
// Import device drivers so they self-register
import '@/devices/hackrf/device';
import '@/devices/rtlsdr/device';
import '@/devices/airspy';
import '@/devices/airspyhf';
import '@/devices/limesdr/device';
import {
	setRemoteHostCallback,
	setRemoteHostFftCallback,
	setRemoteHostAudioCallback,
	setRemoteHostStatsCallback,
	setRemoteHostPocsagCallback,
	setRemoteHostRdsCallback,
	setRemoteHostRtl433Callback,
	setRemoteHostSquelchCallback,
	_ensureRemoteClients,
	_getOrCreateClientState,
	addRemoteClient,
	setRemoteSharedChannelization,
	removeRemoteClient,
	setRemoteVfoParams,
	addRemoteVfo,
	removeRemoteVfo,
	_queueRemoteAudio,
	_mixAndEmitRemoteAudio,
	_reinitRemoteClientWorkers,
	initRemoteClient,
	feedRemoteAudioChunk,
} from '@/worker/streams/remote-clients';
import { startRxStream } from '@/worker/streams/rx-stream';
import type { VfoParams, VfoState, PerfCounters, RxStreamOpts, RemoteClientState, DeviceOpenOpts } from './types';
import { displayToDeviceFrequencyHz } from '@/radio/frequency-shift';
import { selectUsbDevice } from '@/radio/usb-device-selection';

export class Backend {
	// Hardware — generic SDR device
	device: SdrDevice | null = null;
	wasm!: InitOutput;

	// VFO state
	vfoParams?: VfoParams[];
	vfoStates?: VfoState[];
	dspWorkers?: Worker[];
	ddcs?: DspProcessor[];

	// Shared IQ buffers
	sharedIqPools?: Array<SharedArrayBuffer | ArrayBuffer>;
	sharedIqViews?: Int8Array[];
	sabPoolIndex?: number;

	// DSP perf
	_perf?: PerfCounters;
	_perfInterval?: ReturnType<typeof setInterval>;
	_spectrumFps = 20;
	_sharedChannelization = true;
	_whisperEnabled = false;
	_resetWhisperBatches?: () => void;
	_disposeChannelization?: () => void;
	_disposeSpectrum?: () => void;
	_streamGeneration = 0;
	_sharedChannelStats = { bands: 0, vfos: 0, sampleRate: 0 };

	// Internal state
	_sampleRate?: number;
	_centerFreq?: number;
	_makeVfoState?: () => VfoState;
	_spawnWorker?: (index: number, params: VfoParams) => Worker;
	_handleWorkerAudio?: (v: number, msg: DspAudio) => void;
	_mixBuf?: Float32Array;
	_latchedSquelchOpen?: boolean[];

	// Remote client state
	_remoteHostCb?: SamplesCallback;
	_remoteHostFftCb?: SamplesCallback;
	_remoteHostAudioCb?: HostCallback<Parameters<AudioCallback>>;
	_remoteHostStatsCb?: HostCallback<[HostStats]>;
	_remoteClients?: Map<string, RemoteClientState>;
	_remoteHostPocsagCb?: HostCallback<Parameters<PocsagCallback>>;
	_remoteHostRdsCb?: HostCallback<Parameters<RdsCallback>>;
	_remoteHostRtl433Cb?: HostCallback<Parameters<Rtl433Callback>>;
	_remoteHostSquelchCb?: HostCallback<[boolean[]]>;
	_remoteClientCb?: ((data: ArrayBufferView) => void) | null;
	_remoteClientAudioCb?: AudioCallback;
	_remoteClientWhisperCb?: WhisperCallback | null;

	constructor() {}

	async init(): Promise<void> {
		await ensureWasmInitialized();
		this.wasm = await init();
	}

	async open(opts?: DeviceOpenOpts | 'mock'): Promise<boolean> {
		if (this.device) throw new Error('A device is already connected to this receiver');
		if (opts === 'mock') {
			this.device = new MockHackRF();
			await (this.device as MockHackRF).open();
			return true;
		}

		const devices = await navigator.usb.getDevices();
		const usbDevice = selectUsbDevice(devices, opts);
		if (!usbDevice) {
			return false;
		}

		// Detect which driver matches this USB device
		const driverEntry = detectDevice(usbDevice);
		if (!driverEntry) {
			console.error('No SDR driver found for device:', usbDevice.vendorId.toString(16), usbDevice.productId.toString(16));
			return false;
		}

		const device = driverEntry.create();
		try {
			await device.open(usbDevice);
		} catch (error) {
			try {
				await device.close();
			} catch {
				/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
			}
			throw error;
		}
		this.device = device;
		return true;
	}

	async info(): Promise<SdrDeviceInfo> {
		if (!this.device) throw new Error('No device connected');
		return this.device.getInfo();
	}

	getDeviceCapabilities(): DeviceCapabilities | null {
		if (!this.device) return null;
		return {
			deviceType: this.device.deviceType,
			sampleRates: this.device.sampleRates,
			gainControls: this.device.gainControls,
			sampleFormat: this.device.sampleFormat,
		};
	}

	// Remote client methods (imported from remote-clients.ts)
	setRemoteHostCallback = setRemoteHostCallback.bind(this);
	setRemoteHostFftCallback = setRemoteHostFftCallback.bind(this);
	setRemoteHostAudioCallback = setRemoteHostAudioCallback.bind(this);
	setRemoteHostStatsCallback = setRemoteHostStatsCallback.bind(this);
	setRemoteHostPocsagCallback = setRemoteHostPocsagCallback.bind(this);
	setRemoteHostRdsCallback = setRemoteHostRdsCallback.bind(this);
	setRemoteHostRtl433Callback = setRemoteHostRtl433Callback.bind(this);
	setRemoteHostSquelchCallback = setRemoteHostSquelchCallback.bind(this);
	_ensureRemoteClients = _ensureRemoteClients.bind(this);
	_getOrCreateClientState = _getOrCreateClientState.bind(this);
	addRemoteClient = addRemoteClient.bind(this);
	setRemoteSharedChannelization = setRemoteSharedChannelization.bind(this);
	removeRemoteClient = removeRemoteClient.bind(this);
	setRemoteVfoParams = setRemoteVfoParams.bind(this);
	addRemoteVfo = addRemoteVfo.bind(this);
	removeRemoteVfo = removeRemoteVfo.bind(this);
	_queueRemoteAudio = _queueRemoteAudio.bind(this);
	_mixAndEmitRemoteAudio = _mixAndEmitRemoteAudio.bind(this);
	_reinitRemoteClientWorkers = _reinitRemoteClientWorkers.bind(this);
	initRemoteClient = initRemoteClient.bind(this);
	feedRemoteAudioChunk = feedRemoteAudioChunk.bind(this);

	async startRxStream(
		opts: RxStreamOpts,
		spectrumCallback: SamplesCallback,
		audioCallback: AudioCallback,
		whisperCallback: WhisperCallback | null = null,
		pocsagCallback: PocsagCallback | null = null,
		rdsCallback: RdsCallback | null = null,
		dsdStatusCallback: DsdCallback | null = null,
		rtl433Callback: Rtl433Callback | null = null,
	): Promise<void> {
		return startRxStream(
			this,
			opts,
			spectrumCallback,
			audioCallback,
			whisperCallback,
			pocsagCallback,
			rdsCallback,
			dsdStatusCallback,
			rtl433Callback,
		);
	}

	getDspStats() {
		if (!this._perf) return null;

		const currentSquelch = this.vfoStates ? this.vfoStates.map((s) => s.squelchOpen || false) : [];
		const latchedSquelch = this._latchedSquelchOpen || [];
		const combinedSquelch = currentSquelch.map((sq, i) => sq || latchedSquelch[i]);

		this._latchedSquelchOpen = [...currentSquelch];

		return {
			...this._perf.report,
			channelization: this._sharedChannelStats,
			whisperEnabled: this._whisperEnabled,
			audioQueueMs: Math.max(0, ...(this.vfoStates ?? []).map((state) => state.audioQueueLen / 48)),
			squelchOpen: combinedSquelch,
			squelchDb: this.vfoStates ? this.vfoStates.map((s) => s.squelchDb ?? -120) : [],
		};
	}

	setSpectrumFps(value: number): void {
		this._spectrumFps = normalizeSpectrumFps(value);
	}

	setSharedChannelization(enabled: boolean): void {
		this._sharedChannelization = enabled;
	}

	setWhisperEnabled(enabled: boolean): void {
		if (enabled !== this._whisperEnabled) this._resetWhisperBatches?.();
		this._whisperEnabled = enabled;
	}

	setVfoParams(index: number, params: Partial<VfoParams>): void {
		if (!this.vfoParams || index < 0 || index >= this.vfoParams.length) return;
		Object.assign(this.vfoParams[index], params);
		if (params.enabled === false && this.vfoStates?.[index]) this.vfoStates[index].audioQueueLen = 0;

		if (this.dspWorkers && this.dspWorkers[index]) {
			this.dspWorkers[index].postMessage({
				type: 'configure',
				params: this.vfoParams[index],
				centerFreq: this._centerFreq,
			});
		}

		if (params.pocsag === false && this.vfoStates && this.vfoStates[index]) {
			this.vfoStates[index].pocsagDecoder = null;
		}
		if (params.rds === false && this.vfoStates && this.vfoStates[index]) {
			this.vfoStates[index].rdsDecoder = null;
		}
	}

	addVfo(): number {
		if (!this.vfoParams) return -1;
		const centerFreq = this._centerFreq || 100.0;
		const bw = 150000;
		const params: VfoParams = {
			freq: centerFreq,
			mode: 'wfm',
			enabled: false,
			deEmphasis: '50us',
			squelchEnabled: false,
			squelchLevel: -100.0,
			lowPass: true,
			highPass: false,
			bandwidth: bw,
			volume: 50,
			pocsag: false,
			rds: false,
			rdsRegion: 'eu',
		};
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

	// ── Generic device control methods ──────────────────────────────

	async setSampleRate(rate: number): Promise<void> {
		if (!this.device) throw new Error('No device connected');
		await this.device.setSampleRate(rate);
	}

	async setFrequency(centerFreqMhz: number, frequencyShiftMhz = 0): Promise<void> {
		if (!this.device) throw new Error('No device connected');
		await this.device.setFrequency(displayToDeviceFrequencyHz(centerFreqMhz, frequencyShiftMhz));

		this._centerFreq = centerFreqMhz;

		if (this.vfoParams && this.dspWorkers) {
			for (let i = 0; i < this.vfoParams.length; i++) {
				if (this.dspWorkers[i]) {
					this.dspWorkers[i].postMessage({
						type: 'configure',
						params: this.vfoParams[i],
						centerFreq: this._centerFreq,
					});
				}
			}
		}

		if (this._remoteClients) {
			for (const rc of this._remoteClients.values()) {
				if (rc.workers && rc.params) {
					for (let i = 0; i < rc.workers.length; i++) {
						if (rc.workers[i]) {
							rc.workers[i]!.postMessage({
								type: 'configure',
								params: rc.params[i],
								centerFreq: this._centerFreq,
							});
						}
					}
				}
			}
		}
	}

	async setGain(name: string, value: number): Promise<void> {
		if (!this.device) throw new Error('No device connected');
		await this.device.setGain(name, value);
	}

	getRxLevel() {
		return this.device?.getRxLevel?.() ?? null;
	}

	async setGains(gains: Record<string, number>): Promise<void> {
		if (!this.device) throw new Error('No device connected');
		if (this.device.setGains) {
			await this.device.setGains(gains);
		} else {
			for (const [name, value] of Object.entries(gains)) {
				await this.device.setGain(name, value);
			}
		}
	}

	async startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		if (!this.device) throw new Error('No device connected');
		await this.device.startRx(callback);
	}

	async stopRx(): Promise<void> {
		if (!this.device) throw new Error('No device connected');
		this._streamGeneration++;
		try {
			await this.device.stopRx();
		} finally {
			this._disposeChannelization?.();
			this.disposeDsp();
		}
	}

	private disposeDsp(): void {
		this._disposeSpectrum?.();
		this._disposeSpectrum = undefined;
		if (this._perfInterval) {
			clearInterval(this._perfInterval);
			this._perfInterval = undefined;
		}
		this.dspWorkers?.forEach((worker) => worker?.terminate());
		this.dspWorkers = [];
		for (const state of this._remoteClients?.values() ?? []) {
			state.workers.forEach((worker) => worker?.terminate());
			state.workers = state.workers.map(() => null);
		}
		this.ddcs?.forEach((ddc) => {
			try {
				ddc.free();
			} catch {
				/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
			}
		});
		this.ddcs = [];
	}

	async close(): Promise<void> {
		if (!this.device) return;
		this._streamGeneration++;
		try {
			await this.device.close();
		} finally {
			this._disposeChannelization?.();
			this.disposeDsp();
			this.device = null;
		}
	}
}
