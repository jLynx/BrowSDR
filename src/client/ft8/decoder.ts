export interface FT8Message { sync: number; dt: number; hz: number; text: string }

/** One instance per worker. The WASM adapter contains receive routines only. */
export async function createFT8Decoder() {
	const url = new URL('/lib/ft8/decoder.js', self.location.origin).href;
	const { default: createModule } = await import(/* @vite-ignore */ url);
	const wasm = await createModule({ locateFile: () => '/lib/ft8/decoder.wasm' });
	wasm._ft8_init();
	const input = wasm._malloc(180000 * 4);
	const results = wasm._ft8_results();
	return {
		decode(audio: Float32Array): FT8Message[] {
			if (audio.length !== 180000) throw new Error('FT8 requires exactly 15 seconds at 12 kHz.');
			wasm.HEAPF32.set(audio, input / 4);
			const count = wasm._ft8_decode(input, audio.length);
			if (count < 0) throw new Error('Invalid FT8 audio frame.');
			const messages: FT8Message[] = [];
			for (let i = 0; i < count; i++) {
				const offset = results + i * 52;
				const bytes = wasm.HEAPU8.subarray(offset + 12, offset + 52);
				const end = bytes.indexOf(0);
				messages.push({ sync: wasm.HEAPF32[offset / 4], dt: wasm.HEAPF32[offset / 4 + 1],
					hz: wasm.HEAPF32[offset / 4 + 2], text: new TextDecoder().decode(bytes.subarray(0, end < 0 ? 40 : end)) });
			}
			return messages.sort((a, b) => a.hz - b.hz);
		},
		free() { wasm._free(input); },
	};
}
