import { iqView, recordingBytesPerSample } from '@/radio/iq/format';
import type { SdrDevice } from '@/radio/types';
import type { IqRecording, IqReplayProgress } from '@/radio/iq-replay/types';
import { validateIqRecording } from '@/radio/iq-replay/metadata';
import { receiveTransferSize } from '@/radio/receive-transfer';
import { errorMessage } from '@/platform/errors';

/** Disk-backed IQ source, paced by sample time through the normal receive stream. */
export class IqReplayDevice implements SdrDevice {
	readonly deviceType = 'iq-replay';
	get sampleFormat() {
		return this.recording.format === 'cf32_le'
			? ('float32' as const)
			: this.recording.format === 'ci16_le'
				? ('int16' as const)
				: ('int8' as const);
	}
	get nativeIqBits() {
		return this.recording.precisionBits ?? (this.sampleFormat === 'int8' ? 8 : 16);
	}
	readonly gainControls = [];
	readonly sampleRates: number[];
	private get bytesPerSample() {
		return recordingBytesPerSample(this.recording.format ?? 'ci8');
	}
	private offset = 0;
	private generation = 0;
	private delaySeconds = 0;
	private state: IqReplayProgress['state'] = 'ready';
	private error?: string;
	private timer?: ReturnType<typeof setTimeout>;
	private wake?: () => void;
	private task?: Promise<void>;

	constructor(readonly recording: IqRecording) {
		validateIqRecording(recording);
		this.sampleRates = [recording.sampleRate];
	}
	get progress(): IqReplayProgress {
		return {
			state: this.state,
			seconds: this.offset / this.bytesPerSample / this.recording.sampleRate,
			duration: this.recording.file.size / this.bytesPerSample / this.recording.sampleRate,
			delaySeconds: this.delaySeconds,
			error: this.error,
		};
	}
	async open(): Promise<void> {}
	async close(): Promise<void> {
		await this.stopRx();
	}
	getInfo() {
		return Promise.resolve({ name: 'IQ File Replay', product: this.recording.file.name });
	}
	setSampleRate(rate: number): Promise<void> {
		if (rate !== this.recording.sampleRate) throw new Error('Replay sample rate is fixed by the recording.');
		return Promise.resolve();
	}
	setFrequency(frequency: number): Promise<void> {
		if (Math.abs(frequency - this.recording.centerHz) > 0.01)
			throw new Error('Replay centre frequency is fixed by the recording. Tune a VFO within its recorded bandwidth.');
		return Promise.resolve();
	}
	async setGain(): Promise<void> {}
	rewind(): void {
		if (this.state === 'playing') throw new Error('Pause replay before restarting.');
		this.offset = 0;
		this.delaySeconds = 0;
		this.error = undefined;
		this.state = 'ready';
	}
	async startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		await this.stopRx();
		if (this.offset === this.recording.file.size || this.state === 'error') this.rewind();
		this.state = 'playing';
		const generation = ++this.generation;
		this.task = this.play(callback, generation).catch((error: unknown) => {
			if (generation !== this.generation) return;
			this.state = 'error';
			this.error = errorMessage(error);
		});
	}
	async stopRx(): Promise<void> {
		this.generation++;
		if (this.state === 'playing') this.state = 'paused';
		if (this.timer) clearTimeout(this.timer);
		this.wake?.();
		await this.task;
		this.task = undefined;
	}
	private async play(callback: (data: ArrayBufferView) => void, generation: number): Promise<void> {
		const { file, sampleRate } = this.recording;
		const size = receiveTransferSize(sampleRate, 131072 * this.bytesPerSample, this.bytesPerSample, this.bytesPerSample);
		const start = this.offset;
		let epoch = performance.now();
		while (generation === this.generation && this.offset < file.size) {
			// One bounded read is prefetched while waiting for the next delivery time.
			const end = Math.min(file.size, this.offset + size);
			const bytes = await file.slice(this.offset, end).arrayBuffer();
			if (generation !== this.generation) return;
			if (bytes.byteLength !== end - this.offset) throw new Error('The IQ file returned an incomplete read.');
			const target = epoch + ((this.offset - start) / this.bytesPerSample / sampleRate) * 1000;
			if (target > performance.now()) await this.wait(target - performance.now());
			if (generation !== this.generation) return;
			const late = performance.now() - target;
			// A stalled tab/disk stretches replay instead of bursting an unbounded backlog.
			if (late > 100) {
				epoch += late;
				this.delaySeconds += late / 1000;
			}
			callback(iqView(new Uint8Array(bytes), this.sampleFormat));
			this.offset = end;
		}
		if (generation !== this.generation) return;
		// Include the final chunk's duration before announcing the end of playback.
		const remaining = epoch + ((this.offset - start) / this.bytesPerSample / sampleRate) * 1000 - performance.now();
		if (remaining > 0) await this.wait(remaining);
		if (generation === this.generation) this.state = 'ended';
	}
	private async wait(ms: number): Promise<void> {
		await new Promise<void>((resolve) => {
			this.wake = resolve;
			this.timer = setTimeout(resolve, ms);
		});
		this.timer = undefined;
		this.wake = undefined;
	}
}
