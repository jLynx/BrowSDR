import { errorMessage } from '@/platform/errors';
import init, { DspProcessor, SharedChannelizer, set_panic_hook, alloc_iq_buffer, alloc_float_buffer } from '/wasm/dsp/browsdr_dsp.js';
import { RationalResampler } from './streams/dsp-pipeline';
import { demodulateSideband, sidebandOffsetHz } from './decoders/ssb';
import { DSDStream } from './decoders/dsd/dsd-stream';
import { DSD_IF_RATE } from '@/worker/decoders/dsd/constants';
import type { DSDStatus } from './decoders/dsd/types';
import { RDSDecoder } from './decoders/rds';
import { LatestStatus } from './runtime/latest-status';
import { Rtl433Stream } from './decoders/rtl433';
import type { InitOutput } from '/wasm/dsp/browsdr_dsp.js';
import type { DspInput } from './runtime/dsp-messages.types';
import type { VfoParams } from './runtime/types';

if (import.meta.env.DEV) {
	for (const level of ['log', 'warn', 'error'] as const) {
		const original = console[level].bind(console);
		console[level] = (...values: unknown[]) => {
			original(...values);
			self.postMessage({ type: 'dsp_debug_log', level, message: values.map(String).join(' ') });
		};
	}
}

// --- Worker State ---
let wasmInitPromise: Promise<void> | null = null;
let _wasm: InitOutput;
let ddc: DspProcessor;
let vfoState: {
	dcAvg: number;
	carrierAgcGain: number;
	deemphPrev: number;
	deemphRight: number;
	stereo?: boolean;
	deEmphasis?: string;
	agcGain: number;
	ssbPhase: number;
	audioResampler: RationalResampler | null;
	currentIfRate: number;
	scratchBuf: Float32Array;
	audioTarget: Float32Array;
	squelchOpen: boolean;
	squelchDb?: number;
	lastMode?: string;
};
let sharedIqPtr = 0;
let sharedSabViews: Int8Array[] | null = null;
let rdsDdc: DspProcessor | null = null;
let rdsPrevPhase = 0;
let rdsDecoder: InstanceType<typeof RDSDecoder> | null = null;
let sharedFloatPtr = 0;
let inputIsFloat = false;
let inputCenterFreq = 100;
let channelizer: SharedChannelizer | undefined;
let channelKey = '';
let rtl433: Rtl433Stream;

const IF_RATES: Record<string, number> = {
	nfm: 50000,
	wfm: 250000,
	am: 15000,
	usb: 24000,
	lsb: 24000,
	dsb: 24000,
	cw: 3000,
	raw: 48000,
	dsd: DSD_IF_RATE,
};
const AUDIO_RATE = 48000;

async function startup(): Promise<void> {
	if (!wasmInitPromise) {
		wasmInitPromise = init()
			.then((w) => {
				_wasm = w;
				rtl433 = new Rtl433Stream(DspProcessor, _wasm.memory, (message) => self.postMessage(message));
				set_panic_hook();

				// Allocate Wasm memory for this sub-module
				const MAX_USB_SAMPLES = 131072;
				sharedIqPtr = alloc_iq_buffer(MAX_USB_SAMPLES * 2);
				sharedFloatPtr = alloc_float_buffer(MAX_USB_SAMPLES * 2);
				console.log('DSP Worker: Wasm Initialized. IQ Buffer Ptr:', sharedIqPtr);
			})
			.catch((err: unknown) => {
				console.error('DSP Worker: Wasm Init Failed:', err);
			});
	}
	await wasmInitPromise;
}

let systemSampleRate = 2000000;

// DSD decoder state (per-worker, one DSD decoder per VFO)
let dsdStream: DSDStream | null = null;
const dsdStatus = new LatestStatus<DSDStatus>((status) => self.postMessage({ type: 'dsd_status', status }));

self.onmessage = async (e: MessageEvent<DspInput>) => {
	const msg = e.data;
	await startup();

	switch (msg.type) {
		case 'channelize':
			handleDspChannelize(msg);
			break;
		case 'init':
			handleDspInit(msg);
			break;
		case 'configure':
			handleDspConfigure(msg);
			break;
		case 'process':
			handleDspProcess(msg);
			break;
	}
};

function decodeRdsChunk(msg: {
	type: 'process';
	sampleRate?: number;
	centerFreq?: number;
	params: VfoParams;
	floatIq?: boolean;
	useSab?: boolean;
	sabIndex?: number;
	chunkLen: number;
	chunk?: ArrayBuffer;
	chunkId: number;
}) {
	if (rdsDdc && rdsDecoder && msg.params.rds && msg.params.mode === 'wfm') {
		const chunkLen = msg.chunkLen;
		if (chunkLen > 0) {
			const iqPtr = inputIsFloat
				? rdsDdc.process_iq_only_f32_ptr(sharedFloatPtr, chunkLen)
				: rdsDdc.process_iq_only_ptr(sharedIqPtr, chunkLen);
			const iqLen = rdsDdc.get_iq_output_len();
			if (iqLen > 0) {
				const iqView = new Float32Array(_wasm.memory.buffer, iqPtr, iqLen);
				const numSamples = iqLen / 2;
				const mpxOut = new Float32Array(numSamples);
				for (let i = 0; i < numSamples; i++) {
					const ph = Math.atan2(iqView[i * 2 + 1], iqView[i * 2]);
					let diff = ph - rdsPrevPhase;
					if (diff > Math.PI) diff -= 2 * Math.PI;
					else if (diff < -Math.PI) diff += 2 * Math.PI;
					mpxOut[i] = diff;
					rdsPrevPhase = ph;
				}
				// Decode RDS in this worker thread — decoded messages sent via callback
				rdsDecoder.process(mpxOut);
			}
		}
	}
}

function configureDDC(params: VfoParams, systemCenterFreq: number): void {
	rtl433.configure(params, systemSampleRate, systemCenterFreq);
	const ifRate = IF_RATES[params.mode];
	if (ifRate === undefined) {
		console.error(`[DSP Worker] Unknown mode "${params.mode}" — no IF rate defined. Skipping DDC config.`);
		return;
	}
	const modeChanged = vfoState.lastMode !== params.mode;
	if (modeChanged) dsdStatus.reset();
	if (vfoState.currentIfRate !== ifRate || modeChanged) {
		vfoState.audioResampler = new RationalResampler(ifRate, AUDIO_RATE);
		if (vfoState.currentIfRate === ifRate) ddc.reset();
		vfoState.currentIfRate = ifRate;
		ddc.set_if_sample_rate(ifRate);
		vfoState.lastMode = params.mode;
		vfoState.ssbPhase = 0;
		vfoState.dcAvg = 0;
		vfoState.deemphPrev = 0;
		vfoState.deemphRight = 0;
		vfoState.agcGain = 1;
	}

	const offsetFreq = (params.freq - systemCenterFreq) * 1e6;
	// The UI frequency is the suppressed carrier; the channel FIR must be
	// centered half a bandwidth above it for USB, or below it for LSB.
	ddc.set_shift(systemSampleRate, offsetFreq + sidebandOffsetHz(params.mode, params.bandwidth));
	ddc.set_bandwidth(params.bandwidth);
	ddc.set_squelch(params.squelchLevel, params.squelchEnabled);
	configureStereo(params);
	if (params.mode === 'wfm') {
		ddc.set_wfm_mode(true);
	} else {
		ddc.set_wfm_mode(false);
	}

	// Initialize or destroy DSD decoder based on mode
	if (params.mode === 'dsd') {
		if (!dsdStream) {
			dsdStream = new DSDStream((status: DSDStatus) => {
				// Post DSD status to main thread
				dsdStatus.push(status);
			});
		}
		dsdStream.configure(params.freq, params.bandwidth, params.enabled, systemSampleRate);
	} else {
		if (dsdStream) {
			dsdStream.reset();
			dsdStream = null;
		}
	}

	// Apply UI audio filters (High Pass 300Hz, Low Pass BW/2)
	ddc.set_audio_filters(params.lowPass || false, params.highPass || false);

	// RDS: second DspProcessor for MPX extraction + in-worker RDS decoder
	if (params.rds && params.mode === 'wfm') {
		if (!rdsDdc) {
			rdsDdc = new DspProcessor(systemSampleRate, 0.0, 250000);
			rdsDdc.set_if_sample_rate(250000);
			rdsPrevPhase = 0;
		}
		if (!rdsDecoder) {
			rdsDecoder = new RDSDecoder(
				250000,
				(rmsg) => {
					self.postMessage({ type: 'rds', msg: rmsg });
				},
				params.rdsRegion || 'eu',
			);
		}
		rdsDecoder.setRegion(params.rdsRegion || 'eu');
		rdsDdc.set_shift(systemSampleRate, offsetFreq);
	} else {
		if (rdsDdc) {
			rdsDdc.free();
			rdsDdc = null;
		}
		rdsDecoder = null;
	}
}

function configureStereo(params: VfoParams) {
	const stereo = params.mode === 'wfm' && !!params.stereo;
	if (vfoState.stereo !== stereo || vfoState.deEmphasis !== params.deEmphasis) {
		vfoState.deemphPrev = 0;
		vfoState.deemphRight = 0;
		vfoState.stereo = stereo;
		vfoState.deEmphasis = params.deEmphasis;
	}
	ddc.set_stereo(stereo);
}

function processVfoAudio(chunkLenBytes: number, params: VfoParams): Float32Array | null {
	if (!vfoState.audioResampler) return null;
	const mode = params.mode;
	const bw = params.bandwidth;

	if (mode === 'nfm' || mode === 'wfm') {
		return processFmAudio(chunkLenBytes, params);
	} else {
		// Non-FM Path
		const outPtr = inputIsFloat
			? ddc.process_iq_only_f32_ptr(sharedFloatPtr, chunkLenBytes)
			: ddc.process_iq_only_ptr(sharedIqPtr, chunkLenBytes);
		const numOutValues = ddc.get_iq_output_len();
		const numDemodSamples = numOutValues / 2;
		if (numDemodSamples === 0) return null;

		const _ddcOut = new Float32Array(_wasm.memory.buffer, outPtr, numOutValues);

		const squelchDb = measureSquelch(numDemodSamples, _ddcOut);

		if (numDemodSamples > vfoState.scratchBuf.length) {
			vfoState.scratchBuf = new Float32Array(numDemodSamples + 128);
		}
		const audioDemodRateSamples = vfoState.scratchBuf.subarray(0, numDemodSamples);

		if (mode === 'dsd') {
			const squelched = params.squelchEnabled && squelchDb < params.squelchLevel;
			const audio = decodeDigitalAudio(_ddcOut, squelched, numDemodSamples);
			// DSD emits paced silence while scanning or receiving data. An open
			// RF squelch alone is not evidence of decoded voice playback.
			vfoState.squelchOpen = dsdStream?.audioActive ?? false;
			return audio;
		}

		if (params.squelchEnabled && squelchDb < params.squelchLevel) {
			vfoState.squelchOpen = false;
			audioDemodRateSamples.fill(0);
			const result = vfoState.audioResampler.process(audioDemodRateSamples);
			return result.length > 0 ? result : null;
		}

		vfoState.squelchOpen = params.squelchEnabled && squelchDb >= params.squelchLevel;
		const ifRate = vfoState.currentIfRate;

		demodulateAnalogAudio(mode, numDemodSamples, _ddcOut, ifRate, audioDemodRateSamples, bw);

		const result = vfoState.audioResampler.process(audioDemodRateSamples);
		if (result.length === 0) return null;

		for (let i = 0; i < result.length; i++) {
			if (result[i] > 1.0) result[i] = 1.0;
			else if (result[i] < -1.0) result[i] = -1.0;
		}

		return result.slice();
	}
}

function measureSquelch(numDemodSamples: number, _ddcOut: Float32Array<ArrayBuffer>) {
	let squelchMag = 0;
	for (let i = 0; i < numDemodSamples; i++) {
		const dI = _ddcOut[i * 2];
		const dQ = _ddcOut[i * 2 + 1];
		squelchMag += Math.sqrt(dI * dI + dQ * dQ);
	}
	squelchMag /= numDemodSamples;
	const squelchDb = 10 * Math.log10(squelchMag + 1e-12);
	vfoState.squelchDb = squelchDb;
	return squelchDb;
}

function demodulateAnalogAudio(
	mode: string,
	numDemodSamples: number,
	_ddcOut: Float32Array<ArrayBuffer>,
	ifRate: number,
	audioDemodRateSamples: Float32Array<ArrayBufferLike>,
	bw: number,
) {
	if (mode === 'am') {
		for (let i = 0; i < numDemodSamples; i++) {
			const dI = _ddcOut[i * 2];
			const dQ = _ddcOut[i * 2 + 1];
			const mag = Math.sqrt(dI * dI + dQ * dQ);
			const dcAlpha = 0.9999;
			vfoState.dcAvg = dcAlpha * vfoState.dcAvg + (1 - dcAlpha) * mag;
			const demodSample = mag - vfoState.dcAvg;
			const agcAttack = 50.0 / ifRate;
			const agcDecay = 5.0 / ifRate;
			const absSample = Math.abs(demodSample);
			if (absSample > vfoState.agcGain) {
				vfoState.agcGain = vfoState.agcGain * (1 - agcAttack) + absSample * agcAttack;
			} else {
				vfoState.agcGain = vfoState.agcGain * (1 - agcDecay) + absSample * agcDecay;
			}
			const agcScale = vfoState.agcGain > 1e-6 ? 0.5 / vfoState.agcGain : 1.0;
			audioDemodRateSamples[i] = demodSample * agcScale;
		}
	} else if (mode === 'usb' || mode === 'lsb' || mode === 'dsb') {
		demodulateSideband(_ddcOut, audioDemodRateSamples, mode, bw, ifRate, vfoState);
	} else if (mode === 'cw') {
		for (let i = 0; i < numDemodSamples; i++) {
			const dI = _ddcOut[i * 2];
			const dQ = _ddcOut[i * 2 + 1];
			const cwTone = 700;
			const phaseInc = (cwTone / ifRate) * 2 * Math.PI;
			vfoState.ssbPhase += phaseInc;
			if (vfoState.ssbPhase > Math.PI) vfoState.ssbPhase -= 2 * Math.PI;
			if (vfoState.ssbPhase < -Math.PI) vfoState.ssbPhase += 2 * Math.PI;
			const cosP = Math.cos(vfoState.ssbPhase);
			const sinP = Math.sin(vfoState.ssbPhase);
			const rI = dI * cosP - dQ * sinP;
			const demodSample = rI;
			const agcAttack = 50.0 / ifRate;
			const agcDecay = 5.0 / ifRate;
			const absSample = Math.abs(demodSample);
			if (absSample > vfoState.agcGain) {
				vfoState.agcGain = vfoState.agcGain * (1 - agcAttack) + absSample * agcAttack;
			} else {
				vfoState.agcGain = vfoState.agcGain * (1 - agcDecay) + absSample * agcDecay;
			}
			const agcScale = vfoState.agcGain > 1e-6 ? 0.5 / vfoState.agcGain : 1.0;
			audioDemodRateSamples[i] = demodSample * agcScale;
		}
	} else if (mode === 'raw') {
		for (let i = 0; i < numDemodSamples; i++) {
			audioDemodRateSamples[i] = _ddcOut[i * 2];
		}
	} else {
		audioDemodRateSamples.fill(0);
	}
}

function processFmAudio(chunkLenBytes: number, params: VfoParams): Float32Array | null {
	let outPtr: number;
	try {
		outPtr = inputIsFloat ? ddc.process_f32_ptr(sharedFloatPtr, chunkLenBytes) : ddc.process_ptr(sharedIqPtr, chunkLenBytes);
	} catch (e) {
		console.error('DEBUG process_ptr crashed:', e);
		throw e;
	}

	const numAudioSamples = ddc.get_output_len();

	let isSquelched = false;
	if (params.squelchEnabled && numAudioSamples > 0) {
		isSquelched =
			ddc.get_output_len() > 0 && new Float32Array(_wasm.memory.buffer, outPtr, numAudioSamples)[Math.floor(numAudioSamples / 2)] === 0.0;
	}
	vfoState.squelchOpen = !isSquelched;
	vfoState.squelchDb = ddc.get_squelch_db();

	if (numAudioSamples === 0) return null;

	const result = new Float32Array(_wasm.memory.buffer, outPtr, numAudioSamples);

	// De-emphasis
	if (params.deEmphasis !== 'none') {
		let tau = 0;
		if (params.deEmphasis === '22us') tau = 22e-6;
		else if (params.deEmphasis === '50us') tau = 50e-6;
		else if (params.deEmphasis === '75us') tau = 75e-6;

		const alpha = 1.0 / (1.0 + tau * AUDIO_RATE);
		const oneMinusAlpha = 1.0 - alpha;

		const channels = ddc.get_output_channels();
		const history = [vfoState.deemphPrev, vfoState.deemphRight];
		for (let i = 0; i < numAudioSamples; i++) {
			const channel = i % channels;
			const value = alpha * result[i] + oneMinusAlpha * history[channel];
			history[channel] = value;
			result[i] = Math.max(-1, Math.min(1, value));
		}
		vfoState.deemphPrev = history[0];
		vfoState.deemphRight = history[1];
	} else {
		for (let i = 0; i < numAudioSamples; i++) {
			if (result[i] > 1.0) result[i] = 1.0;
			else if (result[i] < -1.0) result[i] = -1.0;
		}
	}

	if (numAudioSamples > vfoState.audioTarget.length) {
		vfoState.audioTarget = new Float32Array(numAudioSamples + 1024);
	}
	const outView = vfoState.audioTarget.subarray(0, numAudioSamples);
	outView.set(result);
	return outView;
}

function handleDspChannelize(msg: Extract<DspInput, { type: 'channelize' }>) {
	const started = performance.now();
	try {
		if (channelKey !== msg.key) {
			channelizer?.free();
			channelizer = new SharedChannelizer(msg.ratio, new Int32Array(msg.centers));
			channelizer.set_batch_samples(Math.min(65536, Math.round(msg.sampleRate * 0.01)));
			channelKey = msg.key;
		}
		channelizer!.process(new Int8Array(msg.chunk));
		const bands = msg.centers
			.map((centerBin: number, index: number) => {
				const length = channelizer!.output_len(index);
				if (!length) return null;
				const source = new Float32Array(_wasm.memory.buffer, channelizer!.output_ptr(index), length);
				const buffer = typeof SharedArrayBuffer === 'undefined' ? source.slice().buffer : new SharedArrayBuffer(length * 4);
				if (typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer) new Float32Array(buffer).set(source);
				return { centerBin, buffer, length };
			})
			.filter(Boolean);
		self.postMessage({
			type: 'bands',
			bands,
			key: msg.key,
			chunkId: msg.chunkId,
			inputSamples: msg.inputSamples,
			dspTime: performance.now() - started,
		});
	} catch (error) {
		self.postMessage({ type: 'channel_error', error: errorMessage(error), inputSamples: msg.inputSamples });
	}
}

function handleDspInit(msg: Extract<DspInput, { type: 'init' }>) {
	rtl433.reset();
	inputIsFloat = false;
	dsdStatus.reset();
	dsdStream?.reset();
	systemSampleRate = msg.sampleRate;
	inputCenterFreq = msg.centerFreq;
	// Initialize the DDC and VFO state
	if (ddc) {
		ddc.free();
	}
	ddc = new DspProcessor(msg.sampleRate, 0.0, msg.params.bandwidth || 150000);

	vfoState = {
		dcAvg: 0,
		carrierAgcGain: 1.0,
		deemphPrev: 0,
		deemphRight: 0,
		agcGain: 1.0,
		ssbPhase: 0.0,
		audioResampler: null as RationalResampler | null,
		currentIfRate: 0,
		scratchBuf: new Float32Array(512),
		audioTarget: new Float32Array(2048),
		squelchOpen: false,
	};
	sharedSabViews = msg.sabs ? msg.sabs.map((s: SharedArrayBuffer) => new Int8Array(s)) : null;

	configureDDC(msg.params, msg.centerFreq);

	self.postMessage({ type: 'init_done' });
}

function handleDspConfigure(msg: Extract<DspInput, { type: 'configure' }>) {
	if (!inputIsFloat) inputCenterFreq = msg.centerFreq;
	configureDDC(msg.params, inputCenterFreq);
	self.postMessage({ type: 'config_done' });
}

function handleDspProcess(msg: Extract<DspInput, { type: 'process' }>) {
	if (!ddc || !vfoState) {
		console.log('DSP Worker: ddc/vfoState unavailable');
		return;
	}

	configureInputRate(msg);
	inputIsFloat = msg.floatIq === true;
	rtl433.configure(msg.params, systemSampleRate, inputCenterFreq);
	// Audio mute does not stop independent RDS or pager decoding.
	if (!msg.params.enabled && !msg.params.pocsag && !(msg.params.rds && msg.params.mode === 'wfm') && !msg.params.rtl433) return;
	if (!copyInputPayload(msg)) return;
	try {
		const processStart = performance.now();
		rtl433.process(inputIsFloat ? sharedFloatPtr : sharedIqPtr, msg.chunkLen, inputIsFloat);
		const audioOut = msg.params.enabled || msg.params.pocsag || msg.params.rds ? processVfoAudio(msg.chunkLen, msg.params) : null;
		const processEnd = performance.now();
		const dspTime = processEnd - processStart;

		if (audioOut) {
			// We MUST slice/copy to isolate it from WASM before transferring
			const cloneOut = audioOut.slice();
			self.postMessage(
				{
					type: 'audio',
					samples: cloneOut.buffer,
					channels: msg.params.mode === 'wfm' && msg.params.stereo ? 2 : 1,
					chunkId: msg.chunkId,
					squelchOpen: vfoState.squelchOpen,
					squelchDb: vfoState.squelchDb ?? -120,
					dspTime: dspTime,
				},
				{ transfer: [cloneOut.buffer] },
			);
		} else {
			self.postMessage({
				type: 'audio',
				samples: null,
				chunkId: msg.chunkId,
				squelchOpen: vfoState.squelchOpen,
				squelchDb: vfoState.squelchDb ?? -120,
				dspTime: dspTime,
			});
		}

		// RDS: extract MPX and decode in-worker (avoids blocking the audio mixer thread)
		decodeRdsChunk(msg);
	} catch (err) {
		self.postMessage({ type: 'error', error: errorMessage(err) });
	}
}

function configureInputRate(msg: {
	type: 'process';
	sampleRate?: number;
	centerFreq?: number;
	params: VfoParams;
	floatIq?: boolean;
	useSab?: boolean;
	sabIndex?: number;
	chunkLen: number;
	chunk?: ArrayBuffer;
	chunkId: number;
}) {
	const nextRate = msg.sampleRate ?? systemSampleRate;
	const nextCenter = msg.centerFreq ?? inputCenterFreq;
	if (nextRate !== systemSampleRate) {
		ddc.free();
		if (rdsDdc) {
			rdsDdc.free();
			rdsDdc = null;
		}
		rdsDecoder = null;
		systemSampleRate = nextRate;
		inputCenterFreq = nextCenter;
		ddc = new DspProcessor(nextRate, 0, msg.params.bandwidth || 150000);
		vfoState.currentIfRate = 0;
		vfoState.dcAvg = 0;
		vfoState.deemphPrev = 0;
		vfoState.deemphRight = 0;
		vfoState.agcGain = 1;
		vfoState.ssbPhase = 0;
		configureDDC(msg.params, nextCenter);
	} else if (nextCenter !== inputCenterFreq) {
		inputCenterFreq = nextCenter;
		ddc.set_shift(nextRate, (msg.params.freq - nextCenter) * 1e6 + sidebandOffsetHz(msg.params.mode, msg.params.bandwidth));
		rdsDdc?.set_shift(nextRate, (msg.params.freq - nextCenter) * 1e6);
	}
}

function copyInputPayload(msg: Extract<DspInput, { type: 'process' }>): boolean {
	// Copy payload into WASM memory
	const wasmMemView = new Int8Array(_wasm.memory.buffer);

	if (msg.useSab && sharedSabViews && msg.sabIndex !== undefined) {
		// Zero-copy grab from SAB ring!
		wasmMemView.set(sharedSabViews[msg.sabIndex].subarray(0, msg.chunkLen), sharedIqPtr);
	} else if (msg.chunk) {
		if (inputIsFloat) {
			new Float32Array(_wasm.memory.buffer, sharedFloatPtr, msg.chunkLen).set(new Float32Array(msg.chunk));
		} else {
			wasmMemView.set(new Int8Array(msg.chunk), sharedIqPtr);
		}
	} else {
		return false; // Invalid chunk
	}

	return true;
}

function decodeDigitalAudio(iq: Float32Array, squelched: boolean, count: number) {
	return dsdStream?.process(iq, squelched) ?? new Float32Array(count);
}
