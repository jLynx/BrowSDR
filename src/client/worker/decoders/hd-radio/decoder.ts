import { isRecord } from '@/platform/data';
import type { HdFactory, HdModule, HdOptions } from './types';

let factoryPromise: Promise<HdFactory> | undefined;
async function loadFactory(): Promise<HdFactory> {
	const url = typeof location === 'undefined' ? '/wasm/nrsc5/nrsc5.js' : new URL('/wasm/nrsc5/nrsc5.js', location.origin).href;
	factoryPromise ??= import(/* @vite-ignore */ url)
		.then((module: unknown) => {
			if (!isRecord(module) || typeof module.default !== 'function') throw new Error('Missing HD Radio decoder factory');
			return module.default as HdFactory;
		})
		.catch((error: unknown) => {
			factoryPromise = undefined;
			throw error;
		});
	return factoryPromise;
}

export class HdDecoder {
	private ptr: number;
	private constructor(private module: HdModule) {
		this.ptr = module._malloc(65536 * 4);
		if (!this.ptr) {
			module._hd_destroy();
			throw new Error('HD Radio could not allocate its IQ buffer');
		}
	}

	static async create(callbacks: Pick<HdOptions, 'onNumbers' | 'onText' | 'onAudio'>): Promise<HdDecoder> {
		const factory = await loadFactory();
		const module = await factory({
			...callbacks,
			locateFile: (file) => '/wasm/nrsc5/' + file,
			print: () => {},
			printErr: () => {},
		});
		if (module._hd_init() !== 0) throw new Error('HD Radio could not initialize the decoder');
		return new HdDecoder(module);
	}

	process(iq: Float32Array): void {
		if (!this.ptr) throw new Error('HD Radio decoder has been destroyed');
		if (iq.length % 2) throw new Error('HD Radio requires interleaved IQ pairs');
		for (let offset = 0; offset < iq.length; offset += 65536) {
			const block = iq.subarray(offset, offset + 65536);
			this.module.HEAPF32.set(block, this.ptr / 4);
			if (this.module._hd_process(this.ptr, block.length) !== 0) throw new Error('HD Radio rejected IQ samples');
		}
	}

	destroy(): void {
		if (!this.ptr) return;
		this.module._free(this.ptr);
		this.ptr = 0;
		this.module._hd_destroy();
	}

	reset(): void {
		this.module._hd_reset();
	}

	setProgram(program: number): void {
		if (this.module._hd_set_program(program) !== 0) throw new Error('HD Radio rejected the program');
	}
}
