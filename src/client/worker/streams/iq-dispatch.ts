import type { DspInput, DspOutput } from '@/worker/runtime/dsp-messages.types';

// At 61.44 MSPS, 32 full LimeSDR chunks cover about 68ms of scheduling jitter.
// Keep half the pool available so a stalled VFO cannot monopolize all slots.
const MAX_PENDING_CHUNKS = 32;

/** Keep input buffers immutable until every consumer finishes its chunk. */
export class IqDispatcher {
	private pending = new Map<Worker, Map<number, number | undefined>>();
	private listeners = new Map<Worker, { message: (event: MessageEvent<DspOutput>) => void; error: () => void }>();
	private failed = new WeakSet<Worker>();
	private leases: Array<Set<Worker>>;
	private nextSlot = 0;

	constructor(private views: Int8Array[]) {
		this.leases = views.map(() => new Set());
	}

	canSend(worker: Worker): boolean {
		return !this.failed.has(worker) && (this.pending.get(worker)?.size ?? 0) < MAX_PENDING_CHUNKS;
	}

	reserve(input: Int8Array): number | undefined {
		for (let offset = 0; offset < this.views.length; offset++) {
			const slot = (this.nextSlot + offset) % this.views.length;
			if (this.leases[slot].size) continue;
			this.views[slot].set(input);
			this.nextSlot = (slot + 1) % this.views.length;
			return slot;
		}
		return undefined;
	}

	send(worker: Worker, message: Extract<DspInput, { type: 'process' }>, transfer: Transferable[] = []): boolean {
		if (!this.canSend(worker)) return false;
		this.watch(worker);
		const requests = this.pending.get(worker)!;
		const slot = message.useSab ? message.sabIndex : undefined;
		requests.set(message.chunkId, slot);
		if (slot !== undefined) this.leases[slot].add(worker);
		try {
			worker.postMessage(message, transfer);
		} catch (error) {
			this.release(worker, message.chunkId);
			throw error;
		}
		return true;
	}

	retain(workers: Set<Worker>): void {
		for (const worker of this.pending.keys()) {
			if (!workers.has(worker)) this.remove(worker);
		}
	}

	dispose(): void {
		for (const worker of this.pending.keys()) this.remove(worker);
	}

	private watch(worker: Worker): void {
		if (this.pending.has(worker)) return;
		this.pending.set(worker, new Map());
		const message = ({ data }: MessageEvent<DspOutput>) => {
			if (data.type === 'audio' || data.type === 'processed' || data.type === 'error') {
				if (data.chunkId !== undefined) this.release(worker, data.chunkId);
			}
		};
		const error = () => {
			this.failed.add(worker);
			this.remove(worker);
		};
		this.listeners.set(worker, { message, error });
		worker.addEventListener('message', message);
		worker.addEventListener('error', error);
		worker.addEventListener('messageerror', error);
	}

	private release(worker: Worker, chunkId: number): void {
		const requests = this.pending.get(worker);
		if (!requests?.has(chunkId)) return;
		const slot = requests.get(chunkId);
		if (slot !== undefined) this.leases[slot].delete(worker);
		requests.delete(chunkId);
	}

	private remove(worker: Worker): void {
		for (const chunkId of this.pending.get(worker)?.keys() ?? []) this.release(worker, chunkId);
		const listeners = this.listeners.get(worker);
		if (listeners) {
			worker.removeEventListener('message', listeners.message);
			worker.removeEventListener('error', listeners.error);
			worker.removeEventListener('messageerror', listeners.error);
		}
		this.listeners.delete(worker);
		this.pending.delete(worker);
	}
}
