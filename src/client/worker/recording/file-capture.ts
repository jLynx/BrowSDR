import { IQ_FILE_BLOCK_SIZE, IQ_MEMORY_LIMIT, iqCaptureTimeout } from './limits';
import type { IqCaptureProgress } from './types';

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

	constructor(
		private readonly totalBytes: number,
		private readonly onInputComplete?: () => void,
	) {
		this.buffer = new Int8Array(Math.min(IQ_FILE_BLOCK_SIZE, totalBytes));
	}

	get progress(): IqCaptureProgress {
		return { capturedBytes: this.capturedBytes, writtenBytes: this.writtenBytes, totalBytes: this.totalBytes };
	}

	push(data: Int8Array): void {
		if (this.error || this.capturedBytes === this.totalBytes) return;
		const length = Math.min(data.length, this.totalBytes - this.capturedBytes);
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
				this.buffer = new Int8Array(Math.min(IQ_FILE_BLOCK_SIZE, this.totalBytes - this.capturedBytes));
				this.bufferOffset = 0;
			}
		}
		if (this.capturedBytes === this.totalBytes) this.onInputComplete?.();
		this.wake?.();
	}

	cancel(message = 'IQ capture cancelled. Incomplete capture discarded.'): void {
		this.error ??= new Error(message);
		this.wake?.();
	}

	async start(file: FileSystemFileHandle, seconds: number): Promise<number> {
		const timer = setTimeout(() => this.cancel('IQ capture timed out waiting for samples'), iqCaptureTimeout(seconds));
		let writer: FileSystemWritableFileStream | undefined;
		try {
			writer = await file.createWritable();
			while (true) {
				if (this.error) throw this.error;
				const block = this.queue.shift();
				if (block) {
					await writer.write(block);
					this.writtenBytes += block.length;
					this.pendingBytes -= block.length;
				} else if (this.capturedBytes === this.totalBytes) {
					break;
				} else {
					await new Promise<void>((resolve) => {
						this.wake = resolve;
					});
					this.wake = undefined;
				}
			}
			await writer.close();
			return this.writtenBytes;
		} catch (error) {
			this.cancel(String(error));
			await writer?.abort().catch(() => undefined);
			throw error;
		} finally {
			clearTimeout(timer);
			this.queue = [];
			this.buffer = new Int8Array(0);
		}
	}
}
