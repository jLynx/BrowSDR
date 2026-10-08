import type { WhisperWorkerScope, BenchmarkMessage, WorkerInMessage, TranscriptionOptions, BenchmarkResult } from './types';
import { errorMessage } from '@/platform/errors';
/**
 * Whisper Speech-to-Text Web Worker
 *
 * Uses @huggingface/transformers to run OpenAI Whisper models
 * entirely in-browser via WebAssembly / WebGPU.
 *
 * Protocol (postMessage):
 *   Main -> Worker:
 *     { type: 'load',      model: 'Xenova/whisper-tiny' }
 *     { type: 'transcribe', audio: Float32Array (16 kHz mono), id: number }
 *
 *   Worker -> Main:
 *     { type: 'status',  message: string }
 *     { type: 'loading', progress: number (0-100) }
 *     { type: 'ready' }
 *     { type: 'result',  text: string, id: number }
 *     { type: 'error',   message: string }
 */

import { WhisperBackend } from './whisper-backend';
import { isHallucination } from './whisper-text';
import { WhisperProgress } from './whisper-progress';

const workerSelf = self as unknown as WhisperWorkerScope;

let pipeline: WhisperBackend | null = null;
let pipelinePromise: Promise<void> | null = null;
let loadedModel = '';
let isMultilingual: boolean = false;

// Serialise transcription requests — the WASM pipeline cannot handle concurrent
// calls.  Without this, continuous audio (e.g. WFM) queues overlapping pipeline()
// invocations that hang the worker, causing the UI to stay stuck on "REC".
let transcribeChain: Promise<void> = Promise.resolve();

async function loadModel(model: string, device?: 'wasm' | 'webgpu'): Promise<void> {
	try {
		if (pipeline && loadedModel === model && !device) {
			workerSelf.postMessage({ type: 'ready', device: pipeline.device });
			return;
		}
		await pipeline?.dispose();
		pipeline = null;
		loadedModel = '';
		workerSelf.postMessage({ type: 'status', message: `Loading Transformers.js…` });

		// Dynamic import from CDN (ES module)
		const { pipeline: createPipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1');

		// Disable local model check -- always fetch from HF Hub via CDN
		env.allowLocalModels = false;

		// In production (Cloudflare Workers), route model downloads through our
		// same-origin proxy to satisfy COEP (Cross-Origin-Embedder-Policy).
		// In local dev, fetch directly from HuggingFace — no proxy needed.
		const hostname = workerSelf.location.hostname;
		const isLocalDev = hostname === 'localhost' || hostname === '127.0.0.1';
		if (!isLocalDev) {
			env.remoteHost = `${workerSelf.location.origin}/hf-proxy`;
		}

		// English-only models (.en) reject language/task parameters
		isMultilingual = !model.endsWith('.en');

		workerSelf.postMessage({ type: 'status', message: `Downloading model ${model}…` });

		// Reserve space for large weight files not yet announced by the downloader.
		const expectedBytes = model.includes('distil-large-v3.5') ? 1514000000 : model.includes('large-v3') ? 1620000000 : 0;
		const progress = new WhisperProgress((message) => workerSelf.postMessage(message), expectedBytes);
		const backend = new WhisperBackend(
			createPipeline,
			model,
			(event) => progress.update(event),
			(device, reason) => workerSelf.postMessage({ type: 'backend', device, reason }),
		);
		await backend.load(
			device === 'wasm'
				? undefined
				: (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features?: { has(feature: string): boolean } } | null> } }).gpu,
		);
		pipeline = backend;
		loadedModel = model;

		workerSelf.postMessage({ type: 'ready', device: backend.device });
	} catch (err: unknown) {
		const message = err instanceof Error ? errorMessage(err) : String(err);
		console.error('[whisper-worker] Model load failed:', err);
		workerSelf.postMessage({ type: 'error', message: `Model load failed: ${message}` });
	}
}

function transcriptionOptions(): TranscriptionOptions {
	// HAM radio-tuned decode options.
	// - temperature=0                -> greedy/deterministic (fast, no random hallucinations)
	// - num_beams=4                  -> wider beam search catches accent-shifted phoneme candidates
	// - condition_on_prev_text=false -> each chunk decoded fresh (less hallucination drift)
	// - initial_prompt               -> NZ HAM vocabulary primes the decoder toward local callsigns,
	//                                  Q-codes, and NZ English spellings/place names so accent-shifted
	//                                  vowels score higher against the right token rather than an
	//                                  American-English near-homophone.
	const opts: TranscriptionOptions = {
		chunk_length_s: 30,
		stride_length_s: 6,
		return_timestamps: false,
		temperature: 0,
		num_beams: 4,
		no_repeat_ngram_size: 3,
		condition_on_prev_text: false,
		initial_prompt:
			// Seed the decoder with NZ emergency-service and HAM code notation.
			// Priming with written codes (K46, R4, Q81) makes Whisper prefer that
			// form over phonetic expansions ("Kay forty-six", "are four").
			// NZ place names anchor the decoder to NZ English phonology.
			'New Zealand emergency services and amateur radio. ' +
			'Fire codes: K1 K2 K22 K28 K31 K32 K44 K45 K46 K46-1 K46-2 K46-3 K46-4 K55 K66 K77 K88 K99. ' +
			'Ambulance: Priority 1 Priority 2 Priority 3. Code 1 Code 2. ' +
			'R4 R6 R7 R9 R13 R17 R25 R33 R43 R49 R99. Status 1 Status 2 Status 3 Status 4. ' +
			'Q81 Q82 Q83 Q84 Q85 Q88 Q89 Q90. ' +
			'Auckland Wellington Christchurch Tauranga Hamilton Rotorua Whangarei Dunedin. ' +
			'Ngaruawahia Papatoetoe Papakura Manukau Otahuhu Waitakere Mangere. ' +
			'Palmerston North Whanganui Napier Hastings Gisborne Invercargill Oamaru. ' +
			'ZL1 ZL2 ZL3 ZL4. CQ QRZ QSO over roger copy standby NFM FM.',
	};
	if (isMultilingual) {
		opts.language = 'en';
		opts.task = 'transcribe';
	}
	return opts;
}

async function transcribe(audio: Float32Array, id: number, audioDuration?: number): Promise<void> {
	if (!pipeline) {
		workerSelf.postMessage({ type: 'discarded', id, reason: 'pipeline-not-ready' });
		return;
	}
	try {
		const opts = transcriptionOptions();
		const t0 = performance.now();
		const result = await pipeline.transcribe(audio, opts);
		const transcribeTime = ((performance.now() - t0) / 1000).toFixed(2);
		const text: string = (result.text || '').trim();

		// Filter out known Whisper hallucinations on silence/noise.
		// IMPORTANT: always post back so main thread can decrement pendingChunks.
		if (!text || isHallucination(text)) {
			workerSelf.postMessage({ type: 'discarded', id, reason: 'hallucination' });
			return;
		}

		workerSelf.postMessage({ type: 'result', text, id, audioDuration, transcribeTime, model: loadedModel });
	} catch (err: unknown) {
		const message = err instanceof Error ? errorMessage(err) : String(err);
		console.error('[whisper-worker] Transcription error:', err);
		workerSelf.postMessage({ type: 'error', message: `Transcription error: ${message}` });
	}
}

async function benchmark(msg: BenchmarkMessage): Promise<void> {
	const results: BenchmarkResult[] = [];
	try {
		for (const device of ['wasm', 'webgpu'] as const) {
			workerSelf.postMessage({ type: 'benchmark-progress', message: `Loading ${device === 'wasm' ? 'CPU' : 'GPU'}…` });
			await loadModel(msg.model, device);
			if (!pipeline || pipeline.device !== device) throw new Error(`${device} backend unavailable`);
			const opts = transcriptionOptions();
			workerSelf.postMessage({ type: 'benchmark-progress', message: `Warming up ${device}…` });
			await pipeline.transcribe(msg.audio, opts);
			const seconds: number[] = [];
			let text = '';
			for (let run = 0; run < 3; run++) {
				workerSelf.postMessage({ type: 'benchmark-progress', message: `${device}: run ${run + 1}/3` });
				const start = performance.now();
				const result = await pipeline.transcribe(msg.audio, opts);
				seconds.push((performance.now() - start) / 1000);
				if (pipeline.device !== device) throw new Error('GPU fell back to CPU during benchmark');
				text = result.text;
			}
			results.push({ device, seconds, median: [...seconds].sort((a, b) => a - b)[1], text });
		}
		workerSelf.postMessage({ type: 'benchmark-result', audioDuration: msg.audio.length / 16000, model: msg.model, results });
	} catch (error) {
		workerSelf.postMessage({ type: 'benchmark-error', message: String(error) });
	}
}

workerSelf.addEventListener('message', (e: MessageEvent<WorkerInMessage>) => {
	const msg = e.data;

	if (msg.type === 'load') {
		// Model disposal/reload must not overlap an in-flight transcription.
		pipelinePromise = transcribeChain.then(() => loadModel(msg.model || 'onnx-community/whisper-small'));
		transcribeChain = pipelinePromise;
	} else if (msg.type === 'benchmark') {
		transcribeChain = transcribeChain.then(() => benchmark(msg));
		pipelinePromise = transcribeChain;
	} else if (msg.type === 'transcribe') {
		const { id, audioDuration, audio } = msg;
		// Chain each transcription so only one pipeline() call runs at a time.
		// The WASM runtime hangs when concurrent calls overlap (common with
		// continuous-audio modes like WFM where chunks arrive every ~10 s).
		const ready = pipelinePromise;
		transcribeChain = transcribeChain
			.then(async () => {
				if (ready) await ready;
				await transcribe(audio, id, audioDuration);
			})
			.catch((err: unknown) => {
				// Last-resort catch: ensure the main thread is never left hanging
				const message = err instanceof Error ? err.message : String(err);
				console.error('[whisper-worker] Unhandled error in run():', err);
				workerSelf.postMessage({ type: 'error', message: `Unhandled worker error: ${message}` });
			});
	}
});
