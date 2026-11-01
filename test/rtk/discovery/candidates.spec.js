import { describe, expect, it } from 'vitest';
import { RtkActivityCandidates } from '@/worker/decoders/rtk/discovery/candidates';

describe('RTK spectrum candidate queue', () => {
	it('avoids duplicating the sweep and other active acquisition channels', () => {
		const queue = new RtkActivityCandidates();
		queue.offer([921.11, 922.11, 923.11], 0, 915, 928, 919);
		expect(queue.take(0, [921.12, 922.12])).toBe(923.11);
		expect(queue.frequencies(0)).toEqual([]);
	});
	it('bounds, deduplicates and clips ranked hints to the requested range', () => {
		const queue = new RtkActivityCandidates();
		queue.offer([NaN, 914, 919, 921.111, 921.112, 922, 929], 0, 915, 928, 919);
		expect(queue.frequencies(0)).toEqual([921.111, 922]);
		queue.offer(
			Array.from({ length: 100 }, (_, i) => 915 + i * 0.1),
			1,
			915,
			928,
			919,
		);
		expect(queue.frequencies(1)).toHaveLength(32);
	});
	it('expires stale bursts, preserves recent bursts through silence and cools down already tried peaks', () => {
		const queue = new RtkActivityCandidates();
		queue.offer([921.111, 922], 0, 915, 928, 919);
		expect(queue.take(1)).toBe(921.111);
		queue.offer([921.112], 2, 915, 928, 919);
		expect(queue.frequencies(2)).toEqual([922]);
		expect(queue.take(31)).toBeUndefined();
		queue.offer([921.112], 32, 915, 928, 919);
		expect(queue.take(32)).toBe(921.112);
	});
});
