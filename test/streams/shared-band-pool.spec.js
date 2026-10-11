import { describe, expect, it } from 'vitest';
import { SharedBandPool } from '@/worker/streams/shared-band-pool';
import { IqDispatcher } from '@/worker/streams/iq-dispatch';

describe('shared band ownership', () => {
	it('keeps a healthy consumer flowing while another consumer stalls', () => {
		const pool = new SharedBandPool();
		const dispatch = new IqDispatcher([]);
		class Consumer extends EventTarget {
			postMessage() {}
		}
		const slow = new Consumer(),
			fast = new Consumer();
		for (let chunkId = 1; chunkId <= 1000; chunkId++) {
			const batch = pool.copy([{ centerBin: 0, samples: new Float32Array(64).fill(chunkId) }]);
			expect(batch.dropped).toBe(false);
			let remaining = 1;
			const done = () => {
				if (--remaining === 0) pool.release(batch.batchId);
			};
			for (const consumer of [slow, fast]) {
				if (!dispatch.canSend(consumer, true)) continue;
				remaining++;
				dispatch.send(consumer, { type: 'process', floatIq: true, chunkId, chunk: batch.bands[0].buffer }, [], done);
			}
			fast.dispatchEvent(new MessageEvent('message', { data: { type: 'processed', chunkId } }));
			done();
		}
	});
	it('bounds allocation and preserves stalled input through band changes and thousands of batches', () => {
		const pool = new SharedBandPool();
		const held = [];
		for (let i = 0; i < 12; i++) held.push(pool.copy([{ centerBin: i, samples: new Float32Array(64).fill(i) }]));
		for (let i = 0; i < 1000; i++) expect(pool.copy([{ centerBin: 0, samples: new Float32Array(64) }]).dropped).toBe(true);
		for (const [i, batch] of held.entries()) expect([...new Float32Array(batch.bands[0].buffer)]).toEqual(Array(64).fill(i));
		const recycled = held[0].bands[0].buffer;
		pool.release(held[0].batchId);
		let previous;
		for (let i = 0; i < 2000; i++) {
			const batch = pool.copy([{ centerBin: i % 8, samples: new Float32Array(60).fill(i) }]);
			expect(batch.bands[0].buffer).toBe(recycled);
			if (previous) pool.release(previous);
			expect(pool.copy([{ centerBin: 0, samples: new Float32Array(64) }]).dropped).toBe(true);
			pool.release(batch.batchId);
			previous = batch.batchId;
		}
	});
});
