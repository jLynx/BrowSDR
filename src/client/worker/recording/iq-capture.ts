import { FileIqCapture } from './file-capture';
import { IQ_MEMORY_LIMIT, iqCaptureByteLength, iqCaptureTimeout } from './limits';
import type { IqCaptureProgress } from './types';

/** Sample-exact recording of signed interleaved I/Q, in memory or streamed to disk. */
export class IqCapture {
	private fileCapture?: FileIqCapture;
	private recording?: {
		data: Int8Array<ArrayBuffer>;
		offset: number;
		resolve: (data: Int8Array<ArrayBuffer>) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	};

	start(sampleRate: number, seconds: number): Promise<Int8Array<ArrayBuffer>> {
		if (this.recording || this.fileCapture) throw new Error('An IQ capture is already running');
		const length = iqCaptureByteLength(sampleRate, seconds);
		if (length > IQ_MEMORY_LIMIT) throw new Error('Captures above 64 MiB must be saved directly to a file');
		return new Promise((resolve, reject) => {
			this.recording = {
				data: new Int8Array(length),
				offset: 0,
				resolve,
				reject,
				timer: setTimeout(() => this.cancel('IQ capture timed out waiting for samples'), iqCaptureTimeout(seconds)),
			};
		});
	}

	startToFile(sampleRate: number, seconds: number, file: FileSystemFileHandle, onInputComplete?: () => void): Promise<number> {
		if (this.recording || this.fileCapture) throw new Error('An IQ capture is already running');
		const capture = new FileIqCapture(iqCaptureByteLength(sampleRate, seconds), onInputComplete);
		this.fileCapture = capture;
		return capture.start(file, seconds).finally(() => {
			this.fileCapture = undefined;
		});
	}

	get progress(): IqCaptureProgress | null {
		if (this.fileCapture) return this.fileCapture.progress;
		const recording = this.recording;
		return recording ? { capturedBytes: recording.offset, writtenBytes: recording.offset, totalBytes: recording.data.length } : null;
	}

	push(data: Int8Array): void {
		this.fileCapture?.push(data);
		const recording = this.recording;
		if (!recording) return;
		const length = Math.min(data.length, recording.data.length - recording.offset);
		recording.data.set(data.subarray(0, length), recording.offset);
		recording.offset += length;
		if (recording.offset === recording.data.length) {
			clearTimeout(recording.timer);
			this.recording = undefined;
			recording.resolve(recording.data);
		}
	}

	cancel(message?: string): void {
		this.fileCapture?.cancel(message);
		if (!this.recording) return;
		clearTimeout(this.recording.timer);
		this.recording.reject(new Error(message ?? 'IQ capture cancelled'));
		this.recording = undefined;
	}
}
