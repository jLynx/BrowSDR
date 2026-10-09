import { describe, expect, it, vi } from 'vitest';
import { IqDispatcher } from '@/worker/streams/iq-dispatch';

class TestWorker extends EventTarget {
	messages = [];
	postMessage(message) {
		this.messages.push(message);
	}
	reply(data) {
		this.dispatchEvent(new MessageEvent('message', { data }));
	}
}

function setup(slots = 64) {
	const views = Array.from({ length: slots }, () => new Int8Array(new SharedArrayBuffer(8)));
	const dispatcher = new IqDispatcher(views);
	const worker = new TestWorker();
	const send = (id, workers = [worker]) => {
		const ready = workers.filter((target) => dispatcher.canSend(target));
		if (!ready.length) return false;
		const slot = dispatcher.reserve(new Int8Array(8).fill(id));
		if (slot === undefined) return false;
		for (const target of ready) dispatcher.send(target, { type: 'process', chunkId: id, useSab: true, sabIndex: slot, chunkLen: 8 });
		return true;
	};
	return { dispatcher, views, worker, send };
}

describe('bounded IQ dispatch', () => {
	it('retains original IQ during thousands of callbacks with a stalled DSP and resumes with fresh input', () => {
		const { dispatcher, worker, views, send } = setup();
		for (let id = 1; id <= 4000; id++) send(id);
		expect(worker.messages).toHaveLength(32);
		for (const message of worker.messages) expect([...views[message.sabIndex]]).toEqual(Array(8).fill(message.chunkId));
		worker.reply({ type: 'audio', chunkId: 1 });
		expect(dispatcher.canSend(worker)).toBe(true);
		send(99);
		expect(worker.messages.at(-1).chunkId).toBe(99);
		expect(worker.messages).toHaveLength(33);
	});
	it('holds a multicast slot until the slowest consumer completes, while another worker continues', () => {
		const { dispatcher, views, worker: slow, send } = setup();
		const fast = new TestWorker();
		for (let id = 1; id <= 32; id++) {
			send(id, [slow, fast]);
			fast.reply({ type: 'audio', chunkId: id });
		}
		for (let id = 33; id <= 100; id++) {
			send(id, [slow, fast]);
			fast.reply({ type: 'audio', chunkId: id });
		}
		expect(slow.messages).toHaveLength(32);
		expect(fast.messages).toHaveLength(100);
		for (const message of slow.messages) expect(views[message.sabIndex][0]).toBe(message.chunkId);
		dispatcher.retain(new Set([fast]));
		for (let id = 33; id <= 96; id++) {
			send(id, [fast]);
			fast.reply({ type: 'audio', chunkId: id });
		}
		expect(views.map((view) => view[0]).sort((a, b) => a - b)).toEqual(Array.from({ length: 64 }, (_, i) => i + 33));
	});
	it('does not overwrite the pool when many consumers occupy different slots', () => {
		const { views, send } = setup(2);
		const first = new TestWorker(),
			second = new TestWorker();
		expect(send(1, [first])).toBe(true);
		expect(send(2, [second])).toBe(true);
		expect(send(3, [first])).toBe(false);
		expect(views.map((view) => view[0])).toEqual([1, 2]);
		second.reply({ type: 'processed', chunkId: 2 });
		expect(send(3, [first])).toBe(true);
	});
	it('bounds transferable and shared-band inputs and only releases matching completions', () => {
		const { dispatcher, worker } = setup();
		for (let id = 1; id <= 100; id++) dispatcher.send(worker, { type: 'process', chunkId: id, chunk: new ArrayBuffer(8) });
		expect(worker.messages).toHaveLength(32);
		worker.reply({ type: 'rds', msg: {} });
		worker.reply({ type: 'audio', chunkId: 99 });
		expect(dispatcher.canSend(worker)).toBe(false);
		worker.reply({ type: 'error', chunkId: 2, error: 'failure' });
		worker.reply({ type: 'error', chunkId: 2, error: 'duplicate' });
		expect(dispatcher.send(worker, { type: 'process', chunkId: 101 })).toBe(true);
		expect(dispatcher.send(worker, { type: 'process', chunkId: 102 })).toBe(false);
	});
	it('releases reservations on send failure and removes failed workers and disposed listeners', () => {
		const { dispatcher, worker, send } = setup();
		worker.postMessage = vi.fn(() => {
			throw new Error('Cannot clone');
		});
		expect(() => send(1)).toThrow('Cannot clone');
		expect(dispatcher.canSend(worker)).toBe(true);
		worker.dispatchEvent(new Event('error'));
		expect(dispatcher.canSend(worker)).toBe(false);
		const healthy = new TestWorker();
		expect(send(2, [healthy])).toBe(true);
		dispatcher.dispose();
		const next = new TestWorker();
		expect(send(3, [next])).toBe(true);
	});
});
