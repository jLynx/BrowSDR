import { IQ_FILE_BLOCK_SIZE, IQ_MEMORY_LIMIT, iqCaptureTimeout } from './limits';
import type { IqCaptureProgress } from './types';
import { iqFileError } from './file-error';

/** Copy USB input into fixed-size blocks; never let a slow disk grow the queue without bound. */
export class FileIqCapture {
	private capturedBytes = 0;
	private writtenBytes = 0;
	private pendingBytes = 0;
	private buffer: Int8Array<ArrayBuffer>;
	private bufferOffset = 0;
	private queue: Array<Int8Array<ArrayBuffer>> = [];
	private wake?: () => void;
	private error?: Error;
	private inputComplete = false;
	private finalizing = false;

	constructor(
		private readonly totalBytes: number | null,
		private readonly onInputComplete?: () => void,
	) {
		this.buffer = new Int8Array(Math.min(IQ_FILE_BLOCK_SIZE, totalBytes ?? IQ_FILE_BLOCK_SIZE));
	}

	get progress(): IqCaptureProgress {
		return {
			capturedBytes: this.capturedBytes,
			writtenBytes: this.writtenBytes,
			totalBytes: this.totalBytes,
			phase: this.finalizing ? 'finalizing' : this.inputComplete ? 'flushing' : 'recording',
		};
	}

	push(data: Int8Array): void {
		if (this.error || this.inputComplete) return;
		const length = Math.min(data.length, this.totalBytes === null ? data.length : this.totalBytes - this.capturedBytes);
		if (this.pendingBytes + length > IQ_MEMORY_LIMIT) {
			this.cancel('IQ capture stopped: disk writes could not keep up. Incomplete capture discarded.');
			return;
		}
		let offset = 0;
		while (offset < length) {
			const count = Math.min(length - offset, this.buffer.length - this.bufferOffset);
			this.buffer.set(data.subarray(offset, offset + count), this.bufferOffset);
			this.bufferOffset += count;
			this.capturedBytes += count;
			this.pendingBytes += count;
			offset += count;
			if (this.bufferOffset === this.buffer.length) {
				this.queue.push(this.buffer);
				this.buffer = new Int8Array(
					Math.min(IQ_FILE_BLOCK_SIZE, this.totalBytes === null ? IQ_FILE_BLOCK_SIZE : this.totalBytes - this.capturedBytes),
				);
				this.bufferOffset = 0;
			}
		}
		if (this.capturedBytes === this.totalBytes) this.stop();
		this.wake?.();
	}

	stop(): void {
		if (this.error || this.inputComplete) return;
		if (!this.capturedBytes) {
			this.cancel('No IQ samples were recorded.');
			return;
		}
		this.inputComplete = true;
		if (this.bufferOffset) {
			this.queue.push(this.buffer.slice(0, this.bufferOffset));
			this.buffer = new Int8Array(0);
			this.bufferOffset = 0;
		}
		this.onInputComplete?.();
		this.wake?.();
	}

	cancel(message = 'IQ capture cancelled. Incomplete capture discarded.'): void {
		this.error ??= new Error(message);
		this.wake?.();
	}

	async start(file: FileSystemFileHandle, seconds: number | null): Promise<number> {
		const timer =
			seconds === null ? undefined : setTimeout(() => this.cancel('IQ capture timed out waiting for samples'), iqCaptureTimeout(seconds));
		let writer: FileSystemWritableFileStream | undefined;
		let operation = 'opening';
		try {
			writer = await file.createWritable();
			operation = 'writing';
			while (true) {
				if (this.error) throw this.error;
				const block = this.queue.shift();
				if (block) {
					await writer.write(block);
					this.writtenBytes += block.length;
					this.pendingBytes -= block.length;
				} else if (this.inputComplete) {
					break;
				} else {
					await new Promise<void>((resolve) => {
						this.wake = resolve;
					});
					this.wake = undefined;
				}
			}
			this.finalizing = true;
			operation = 'finalizing';
			clearTimeout(timer);
			await writer.close();
			return this.writtenBytes;
		} catch (error) {
			const failure = this.error ?? iqFileError(error, operation, file.name, this.writtenBytes);
			this.cancel(failure.message);
			// A failed close cannot be retried. Avoid further operations on a surviving swap file.
			if (operation !== 'finalizing') await writer?.abort().catch(() => undefined);
			throw failure;
		} finally {
			clearTimeout(timer);
			this.queue = [];
			this.buffer = new Int8Array(0);
		}
	}
}
