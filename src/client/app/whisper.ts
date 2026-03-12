import type { AppInstance } from './types';

export const whisperMethods = {
	toggleTranscriptPanel(this: AppInstance) {
		this.whisper.panelOpen = !this.whisper.panelOpen;
	},
	async toggleWhisper(this: AppInstance) {
		if (this.whisper.active) {
			this.stopWhisper();
		} else {
			await this.startWhisper();
		}
	},
	async startWhisper(this: AppInstance) {
		if (!this.running) {
			this.showMsg('Start the SDR stream first.');
			return;
		}

		// Create worker if not yet alive
		if (!this._whisperWorker) {
			this._whisperWorker = new Worker('./whisper-worker.js', { type: 'module' });
			this._whisperWorker.addEventListener('message', (e: MessageEvent) => this._onWhisperMessage(e));
		}

		// Load model
		this.whisper.status = 'loading';
		this.whisper.loadProgress = 0;
		this.whisper.loadPhase = 'downloading';
		this.whisper.loadFile = '';
		this.whisper.loadFilesDone = 0;
		this.whisper.loadFilesTotal = 0;
		this._whisperWorker.postMessage({ type: 'load', model: this.whisper.model });

		// Per-VFO whisper accumulation buffers (keyed by vfoIndex)
		this._whisperVfoStates = {};
		this._whisperChunkId = 0;
		this._whisperChunkMeta = {}; // id → { startTime, freq }
		this.whisper.active = true;
	},
	stopWhisper(this: AppInstance) {
		this.whisper.active = false;
		this.whisper.recording = false;
		this.whisper.transcribing = false;
		this.whisper.pendingChunks = 0;
		this.whisper.recordDuration = 0;
		this._whisperVfoStates = {};
	},
	_onWhisperMessage(this: AppInstance, e: MessageEvent) {
		const msg = e.data;
		switch (msg.type) {
			case 'status':
				this.whisper.statusMsg = msg.message;
				break;
			case 'loading':
				this.whisper.loadProgress = msg.progress;
				this.whisper.loadPhase = msg.phase || 'downloading';
				this.whisper.loadFile = msg.file || '';
				this.whisper.loadFilesDone = msg.filesDone ?? this.whisper.loadFilesDone;
				this.whisper.loadFilesTotal = msg.filesTotal ?? this.whisper.loadFilesTotal;
				break;
			case 'ready':
				this.whisper.status = 'ready';
				this.showMsg('Whisper model loaded — transcription active.');
				break;
			case 'result': {
				const text = msg.text;
				// Track pending count
				this.whisper.pendingChunks = Math.max(0, this.whisper.pendingChunks - 1);
				if (this.whisper.pendingChunks === 0) {
					this.whisper.transcribing = false;
				}
				// Use metadata captured when the audio recording started, not at result time
				const meta = (this._whisperChunkMeta || {})[msg.id] || {};
				delete (this._whisperChunkMeta || {})[msg.id];
				const time = meta.startTime
					? meta.startTime.toLocaleTimeString()
					: new Date().toLocaleTimeString();
				const freq = meta.freq || '';
				const vfoIndex = meta.vfoIndex ?? null;
				const duration = msg.audioDuration ? msg.audioDuration.toFixed(1) + 's' : '';
				const transcribeTime = msg.transcribeTime ? msg.transcribeTime + 's' : '';
				this.whisper.log.push({ time, freq, text, duration, transcribeTime, vfoIndex });
				// Auto-scroll
				this.$nextTick(() => {
					const el = this.$refs.transcriptBody;
					if (el) el.scrollTop = el.scrollHeight;
				});
				break;
			}
			case 'error':
				this.whisper.status = 'error';
				this.whisper.statusMsg = msg.message;
				this.showMsg('Whisper: ' + msg.message);
				// An error also consumes a pending slot
				this.whisper.pendingChunks = Math.max(0, this.whisper.pendingChunks - 1);
				if (this.whisper.pendingChunks === 0) this.whisper.transcribing = false;
				break;
			case 'discarded':
				// Worker silently dropped this chunk (hallucination/silence).
				// Still need to decrement so the "Transcribing…" badge clears.
				this.whisper.pendingChunks = Math.max(0, this.whisper.pendingChunks - 1);
				if (this.whisper.pendingChunks === 0) this.whisper.transcribing = false;
				delete (this._whisperChunkMeta || {})[msg.id];
				break;
		}
	},
	/** Feed isolated per-VFO audio (48 kHz) from the worker into the per-VFO Whisper buffer. */
	_feedWhisperVfo(this: AppInstance, vfoIndex: number, freqMhz: number, samples48k: Float32Array) {
		if (!this.whisper.active || this.whisper.status !== 'ready') return;

		// Down-sample 48 kHz → 16 kHz with 3-tap box-filter anti-aliasing.
		// Averaging consecutive triplets acts as a low-pass (~5 kHz cutoff),
		// removing aliasing while preserving voice (300 Hz – 3 kHz).
		const ratio = 3;
		const outLen = Math.floor(samples48k.length / ratio);
		const down = new Float32Array(outLen);
		for (let i = 0; i < outLen; i++) {
			const j = i * ratio;
			down[i] = (samples48k[j] + (samples48k[j + 1] || 0) + (samples48k[j + 2] || 0)) / 3;
		}

		// Lazily init per-VFO state
		if (!this._whisperVfoStates) this._whisperVfoStates = {};
		if (!this._whisperVfoStates[vfoIndex]) {
			this._whisperVfoStates[vfoIndex] = {
				buf: [], bufLen: 0, silenceRun: 0,
				recording: false, recordStart: null, recordStartFreq: '',
			};
		}
		const vs = this._whisperVfoStates[vfoIndex];

		// Check if this VFO has squelch enabled
		const vfo = this.vfos[vfoIndex];
		const squelchMode = vfo && vfo.squelchEnabled;

		// RMS energy check
		let sumSq = 0;
		for (let i = 0; i < down.length; i++) sumSq += down[i] * down[i];
		const rms = Math.sqrt(sumSq / down.length);
		const isSilent = rms < 0.005;

		if (squelchMode) {
			// ── Squelch-aware mode: accumulate entire transmission ──
			if (!isSilent) {
				if (!vs.recording) {
					vs.recording = true;
					vs.recordStart = new Date();
					vs.recordStartFreq = this.formatFreq(freqMhz) + ' MHz';
				}
				vs.buf.push(down);
				vs.bufLen += down.length;
				vs.silenceRun = 0;
				// Safety cap: flush at 120 s
				if (vs.bufLen >= 16000 * 120) this._flushWhisperVfoBuf(vfoIndex);
			} else {
				if (vs.bufLen > 0) {
					vs.silenceRun += down.length;
					if (vs.silenceRun >= 16000 * 0.5) this._flushWhisperVfoBuf(vfoIndex);
				}
			}
		} else {
			// ── Fixed-interval mode ──
			if (isSilent) return;
			if (!vs.recording) {
				vs.recording = true;
				vs.recordStart = new Date();
				vs.recordStartFreq = this.formatFreq(freqMhz) + ' MHz';
			}
			vs.buf.push(down);
			vs.bufLen += down.length;
			if (vs.bufLen >= 16000 * this.whisper.chunkSeconds) this._flushWhisperVfoBuf(vfoIndex);
		}

		// Update aggregate recording UI state (true if any VFO is recording)
		const anyRecording = Object.values(this._whisperVfoStates).some((s: any) => s.recording);
		this.whisper.recording = anyRecording;
		if (anyRecording) {
			const maxDur = Math.max(...Object.values(this._whisperVfoStates).map((s: any) => s.bufLen / 16000));
			this.whisper.recordDuration = maxDur;
		}
	},
	/** Flush one VFO's accumulation buffer to the Whisper worker. */
	_flushWhisperVfoBuf(this: AppInstance, vfoIndex: number) {
		const vs = this._whisperVfoStates && this._whisperVfoStates[vfoIndex];
		if (!vs || vs.bufLen === 0) return;

		const audioDuration = vs.bufLen / 16000;
		const full = new Float32Array(vs.bufLen);
		let offset = 0;
		for (const chunk of vs.buf) { full.set(chunk, offset); offset += chunk.length; }

		vs.buf = [];
		vs.bufLen = 0;
		vs.silenceRun = 0;
		vs.recording = false;

		// Update aggregate UI state
		this.whisper.recording = Object.values(this._whisperVfoStates).some((s: any) => s.recording);
		if (!this.whisper.recording) this.whisper.recordDuration = 0;

		// Final RMS guard — discard silence.  Then normalise to ~0.08 RMS so
		// Whisper handles weak HAM signals as confidently as strong ones.
		// Gain is capped at 20× to avoid flooding the model with pure noise.
		let sumSq = 0;
		for (let i = 0; i < full.length; i++) sumSq += full[i] * full[i];
		const rmsOut = Math.sqrt(sumSq / full.length);
		if (rmsOut < 0.003) return;
		if (rmsOut < 0.08) {
			const gain = Math.min(0.08 / rmsOut, 20.0);
			for (let i = 0; i < full.length; i++) full[i] = Math.max(-1, Math.min(1, full[i] * gain));
		}

		this.whisper.transcribing = true;
		this.whisper.pendingChunks++;

		const id = this._whisperChunkId++;
		if (!this._whisperChunkMeta) this._whisperChunkMeta = {};
		this._whisperChunkMeta[id] = {
			startTime: vs.recordStart || new Date(),
			freq: vs.recordStartFreq,
			vfoIndex,
		};
		this._whisperWorker.postMessage(
			{ type: 'transcribe', audio: full, id, audioDuration },
			[full.buffer]
		);
	},
	clearTranscript(this: AppInstance) {
		this.whisper.log = [];
	},
	exportTranscript(this: AppInstance) {
		const lines = this.whisper.log.map((e: any) => `[${e.time}] ${e.freq}  ${e.text}`);
		const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `transcript-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
		a.click();
		URL.revokeObjectURL(url);
	},
};
