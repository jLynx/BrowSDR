import { afterEach, describe, expect, it, vi } from 'vitest';
import { IqCapture } from '@/worker/recording/iq-capture';
import { IQ_FILE_BLOCK_SIZE, IQ_MEMORY_LIMIT } from '@/worker/recording/limits';

afterEach(() => vi.useRealTimers());

function fileSink(write = async () => {}) {
	const writer = { write: vi.fn(write), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
	return { writer, file: { createWritable: vi.fn(async () => writer) } };
}

describe('IQ capture streamed to a file', () => {
	it('completes 15 minutes at 250 kSPS without allocating the recording in memory', async () => {
		const capture = new IqCapture();
		let written = 0,
			largestBlock = 0;
		const { file, writer } = fileSink(async (block) => {
			written += block.length;
			largestBlock = Math.max(largestBlock, block.length);
			expect(block[0]).toBe(-128);
		});
		const done = capture.startToFile(250000, 900, file);
		expect(capture.progress.totalBytes).toBe(450000000);
		expect(() => capture.start(1, 1)).toThrow('already running');
		const input = new Int8Array(IQ_FILE_BLOCK_SIZE).fill(-128);
		for (let bytes = 0; bytes < 450000000; bytes += input.length) {
			capture.push(input);
			// Let the simulated disk consume each copied block before the next USB input.
			await new Promise((resolve) => setImmediate(resolve));
		}
		expect(await done).toBe(450000000);
		expect(written).toBe(450000000);
		expect(largestBlock).toBe(IQ_FILE_BLOCK_SIZE);
		expect(writer.close).toHaveBeenCalledOnce();
		expect(writer.abort).not.toHaveBeenCalled();
		expect(capture.progress).toBeNull();
	});

	it('copies reused USB buffers, preserves signed I/Q and truncates the last block exactly', async () => {
		const blocks = [];
		const { file, writer } = fileSink(async (block) => {
			blocks.push(Array.from(block));
		});
		const capture = new IqCapture();
		const done = capture.startToFile(3, 1, file);
		const input = new Int8Array([-128, 127, 1, -1]);
		capture.push(input);
		input.fill(42);
		capture.push(new Int8Array([2, -2, 3, -3]));
		expect(await done).toBe(6);
		expect(blocks.flat()).toEqual([-128, 127, 1, -1, 2, -2]);
		expect(writer.close).toHaveBeenCalledOnce();
	});

	it('aborts a slow disk at the bounded queue limit without silently losing samples', async () => {
		let finishWrite;
		const { file, writer } = fileSink(
			() =>
				new Promise((resolve) => {
					finishWrite = resolve;
				}),
		);
		const capture = new IqCapture();
		const done = capture.startToFile(2e6, 900, file);
		const rejection = expect(done).rejects.toThrow('disk writes could not keep up');
		const input = new Int8Array(IQ_FILE_BLOCK_SIZE);
		capture.push(input);
		await new Promise((resolve) => setImmediate(resolve));
		for (let i = 1; i <= IQ_MEMORY_LIMIT / input.length; i++) capture.push(input);
		expect(capture.progress.capturedBytes).toBe(IQ_MEMORY_LIMIT);
		finishWrite();
		await rejection;
		expect(writer.abort).toHaveBeenCalledOnce();
		expect(writer.close).not.toHaveBeenCalled();
		expect(capture.progress).toBeNull();
	});

	it('cancels while opening the file and allows a new capture after cleanup', async () => {
		let open;
		const { writer } = fileSink();
		const capture = new IqCapture();
		const done = capture.startToFile(1e6, 1800, {
			createWritable: () =>
				new Promise((resolve) => {
					open = resolve;
				}),
		});
		const rejection = expect(done).rejects.toThrow('retuned');
		capture.cancel('retuned');
		open(writer);
		await rejection;
		expect(writer.abort).toHaveBeenCalledOnce();
		expect(writer.close).not.toHaveBeenCalled();
		const next = capture.start(1, 1);
		capture.push(new Int8Array([1, -1]));
		expect(Array.from(await next)).toEqual([1, -1]);
	});

	it.each(['write', 'close'])('propagates a %s error and cleans up the incomplete file', async (operation) => {
		const { file, writer } = fileSink();
		writer[operation].mockRejectedValueOnce(new Error('disk full'));
		const capture = new IqCapture();
		const done = capture.startToFile(1, 1, file);
		const rejection = expect(done).rejects.toThrow('disk full');
		capture.push(new Int8Array([1, -1]));
		await rejection;
		expect(writer.abort).toHaveBeenCalledOnce();
		expect(capture.progress).toBeNull();
	});

	it('times out and aborts when reception supplies no samples', async () => {
		vi.useFakeTimers();
		const { file, writer } = fileSink();
		const capture = new IqCapture();
		const done = capture.startToFile(1, 1, file);
		const rejection = expect(done).rejects.toThrow('timed out');
		await vi.advanceTimersByTimeAsync(10000);
		await rejection;
		expect(writer.abort).toHaveBeenCalledOnce();
	});
});
