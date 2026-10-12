import { describe, expect, it } from 'vitest';
import { appendAudio } from '@/worker/streams/audio-queue';

describe('bounded audio queues', () => {
	it('drops oldest overflow and preserves recent audio in order', () => {
		const queue = new Float32Array(5);
		let length = appendAudio(queue, 0, new Float32Array([1, 2, 3, 4]));
		length = appendAudio(queue, length, new Float32Array([5, 6, 7]));
		expect(length).toBe(5);
		expect([...queue]).toEqual([3, 4, 5, 6, 7]);
		length = appendAudio(queue, length, new Float32Array([8, 9, 10, 11, 12, 13]));
		expect(length).toBe(5);
		expect([...queue]).toEqual([9, 10, 11, 12, 13]);
	});
});
