import { AUDIO_RATE } from '@/worker/runtime/types';

export const AUDIO_QUEUE_CAPACITY = AUDIO_RATE / 2;
const MAX_SKEW = AUDIO_RATE / 4;
const MAX_MIX_CHUNK = AUDIO_RATE / 10;

/** Keep recent audio within a fixed latency budget, discarding oldest overflow. */
export function appendAudio(queue: Float32Array, length: number, samples: Float32Array): number {
	const incoming = samples.subarray(Math.max(0, samples.length - queue.length));
	const retained = Math.min(length, queue.length - incoming.length);
	if (retained < length) queue.copyWithin(0, length - retained, length);
	queue.set(incoming, retained);
	return retained + incoming.length;
}

/** Wait for ordinary worker jitter; use silence for channels that fall far behind. */
export function mixLength(lengths: number[]): number {
	if (!lengths.length) return 0;
	const minimum = Math.min(...lengths);
	const maximum = Math.max(...lengths);
	return Math.min(MAX_MIX_CHUNK, maximum - minimum >= MAX_SKEW ? maximum : minimum);
}
