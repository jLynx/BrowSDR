import type { RdsCallback, Rtl433Callback, DsdCallback } from '@/worker/runtime/callbacks.types';
import type { DspOutput } from '@/worker/runtime/dsp-messages.types';
import type { VfoParams, VfoState } from '@/worker/runtime/types';
import type { Backend } from '@/worker/runtime/backend';
import { AUDIO_QUEUE_CAPACITY } from './audio-queue';
export function initializeVfoWorkers(
	backend: Backend,
	centerFreq: number,
	rtl433Callback: Rtl433Callback | null,
	rdsCallback: RdsCallback | null,
	dsdStatusCallback: DsdCallback | null,
	sampleRate: number,
) {
	const initialBandwidth = 150000;

	// Free any existing DDCs and timers
	if (backend.ddcs)
		backend.ddcs.forEach((d) => {
			try {
				d.free();
			} catch (_) {
				/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
			}
		});
	if (backend._perfInterval) {
		clearInterval(backend._perfInterval);
		backend._perfInterval = undefined;
	}

	// Initialize dynamic VFO arrays (start with one VFO)
	const defaultVfoParams: VfoParams = {
		freq: centerFreq,
		mode: 'wfm',
		enabled: false,
		deEmphasis: '50us',
		squelchEnabled: false,
		squelchLevel: -100.0,
		lowPass: true,
		highPass: false,
		bandwidth: initialBandwidth,
		volume: 50,
		pocsag: false,
		rds: false,
		rdsRegion: 'eu',
	};
	backend.vfoParams = [{ ...defaultVfoParams }];

	const MAX_USB_SAMPLES = 131072;
	const SHARED_IQ_CAPACITY = MAX_USB_SAMPLES * 2;
	const SAB_POOL_SIZE = 8;
	backend.sabPoolIndex = 0;

	backend.sharedIqPools = [];
	backend.sharedIqViews = [];
	for (let i = 0; i < SAB_POOL_SIZE; i++) {
		const pool = typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(SHARED_IQ_CAPACITY) : new ArrayBuffer(SHARED_IQ_CAPACITY);
		backend.sharedIqPools.push(pool);
		backend.sharedIqViews.push(new Int8Array(pool));
	}

	const makeVfoState = (): VfoState => ({
		squelchOpen: false,
		squelchDb: -120,
		pocsagDecoder: null,
		rdsDecoder: null,
		audioQueue: new Float32Array(AUDIO_QUEUE_CAPACITY),
		audioQueueLen: 0,
	});
	backend.vfoStates = [makeVfoState()];
	backend.dspWorkers = [];

	const spawnWorker = (index: number, params: VfoParams): Worker => {
		const worker = new globalThis.Worker(new URL('../dsp-worker.ts', import.meta.url), { type: 'module' });
		worker.onmessage = (e: MessageEvent<DspOutput>) =>
			routeLocalWorkerMessage(backend, worker, e.data, rtl433Callback, rdsCallback, dsdStatusCallback);
		worker.postMessage({
			type: 'init',
			sampleRate: sampleRate,
			centerFreq: centerFreq,
			params: params,
			sabs: typeof SharedArrayBuffer !== 'undefined' ? backend.sharedIqPools : null,
		});
		return worker;
	};
	backend.dspWorkers.push(spawnWorker(0, backend.vfoParams[0]));

	backend._makeVfoState = makeVfoState;
	backend._spawnWorker = spawnWorker;
	backend._sampleRate = sampleRate;
	backend._centerFreq = centerFreq;
	return SAB_POOL_SIZE;
}

export function routeLocalWorkerMessage(
	backend: Backend,
	worker: Worker,
	msg: DspOutput,
	rtl433Callback: Rtl433Callback | null,
	rdsCallback: RdsCallback | null,
	dsdStatusCallback: DsdCallback | null,
) {
	if (msg.type === 'rtl433_event' || msg.type === 'rtl433_status') {
		routeSensorMessage(backend, worker, msg, rtl433Callback);
		return;
	}
	if (msg.type === 'audio') {
		// Look up current index dynamically — splice() in removeVfo
		// shifts the array, so the captured `index` goes stale.
		const currentIndex = backend.dspWorkers!.indexOf(worker);
		if (currentIndex === -1) return; // worker was removed
		backend._handleWorkerAudio!(currentIndex, msg);
	} else if (msg.type === 'rds') {
		const currentIndex = backend.dspWorkers!.indexOf(worker);
		if (currentIndex === -1) return;
		// Forward decoded RDS using the worker's current VFO index.
		const params = backend.vfoParams![currentIndex];
		if (rdsCallback && params) rdsCallback(currentIndex, params.freq, msg.msg);
	} else if (msg.type === 'dsd_status') {
		const currentIndex = backend.dspWorkers!.indexOf(worker);
		if (currentIndex === -1) return;
		if (dsdStatusCallback) dsdStatusCallback(currentIndex, msg.status);
	} else if (msg.type === 'dsp_debug_log' && import.meta.env.DEV) {
		const currentIndex = backend.dspWorkers!.indexOf(worker);
		if (currentIndex !== -1) console[msg.level](`[DSP VFO ${currentIndex + 1}] ${msg.message}`);
	} else if (msg.type === 'error') {
		const currentIndex = backend.dspWorkers!.indexOf(worker);
		console.error(`[DSP Worker ${currentIndex}] Error:`, msg.error);
	}
}

function routeSensorMessage(
	backend: Backend,
	worker: Worker,
	msg: Extract<DspOutput, { type: 'rtl433_event' | 'rtl433_status' }>,
	rtl433Callback: Rtl433Callback | null,
) {
	if (msg.type === 'rtl433_event' || msg.type === 'rtl433_status') {
		const currentIndex = backend.dspWorkers!.indexOf(worker);
		const params = backend.vfoParams![currentIndex];
		if (currentIndex >= 0 && params && params.freq === msg.freq && (msg.type === 'rtl433_status' || params.rtl433)) {
			rtl433Callback?.(currentIndex, params.freq, msg);
		}
		return;
	}
}
