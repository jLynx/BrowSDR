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
		timer?: ReturnType<typeof setTimeout>;
	};

	/** A null duration records until stopped or the memory limit is reached. */
	start(sampleRate: number, seconds: number | null): Promise<Int8Array<ArrayBuffer>> {
		if (this.recording || this.fileCapture) throw new Error('An IQ capture is already running');
		const requestedLength = iqCaptureByteLength(sampleRate, seconds ?? 1);
		const length = seconds === null ? IQ_MEMORY_LIMIT : requestedLength;
		if (length > IQ_MEMORY_LIMIT) throw new Error('Captures above 64 MiB must be saved directly to a file');
		return new Promise((resolve, reject) => {
			this.recording = {
				data: new Int8Array(length),
				offset: 0,
				resolve,
				reject,
				timer:
					seconds === null
						? undefined
						: setTimeout(() => this.cancel('IQ capture timed out waiting for samples'), iqCaptureTimeout(seconds)),
			};
		});
	}

	startToFile(sampleRate: number, seconds: number | null, file: FileSystemFileHandle, onInputComplete?: () => void): Promise<number> {
		if (this.recording || this.fileCapture) throw new Error('An IQ capture is already running');
		const requestedLength = iqCaptureByteLength(sampleRate, seconds ?? 1);
		const capture = new FileIqCapture(seconds === null ? null : requestedLength, onInputComplete);
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
			this.stop();
		}
	}

	stop(): void {
		this.fileCapture?.stop();
		const recording = this.recording;
		if (!recording) return;
		if (!recording.offset) {
			this.cancel('No IQ samples were recorded.');
			return;
		}
		clearTimeout(recording.timer);
		this.recording = undefined;
		recording.resolve(recording.offset === recording.data.length ? recording.data : recording.data.slice(0, recording.offset));
	}

	cancel(message?: string): void {
		this.fileCapture?.cancel(message);
		if (!this.recording) return;
		clearTimeout(this.recording.timer);
		this.recording.reject(new Error(message ?? 'IQ capture cancelled'));
		this.recording = undefined;
	}
}
