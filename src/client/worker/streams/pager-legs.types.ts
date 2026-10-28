/**
 * Worker IO bound to a PagerLegs instance. The pointer/memory accessors are
 * read per chunk because the WASM heap can be re-allocated (detaching the old
 * ArrayBuffer) between chunks.
 */
export interface PagerLegIo {
	inputIsFloat: () => boolean;
	floatPtr: () => number;
	iqPtr: () => number;
	wasmMemory: () => ArrayBuffer;
	post: (message: unknown, transfer: Transferable[]) => void;
	onError: (message: string, chunkId: number) => void;
}
