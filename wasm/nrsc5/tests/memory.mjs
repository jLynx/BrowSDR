import assert from 'node:assert/strict';

const { default: createModule } = await import('../build/memory-test.js');
const frames = Array(8).fill(0);
const module = await createModule({
	onNumbers: () => {},
	onText: () => {},
	onAudio: (program, pcm, flags) => {
		assert.equal(pcm.length, 4096);
		assert.ok(pcm.every((value) => value === 0));
		if (flags === 0) frames[program]++;
	},
	print: () => {},
	printErr: () => {},
});
assert.equal(module._hd_test_memory(), 0, 'HDC stack, program selection and codec cleanup');
assert.ok(
	frames.every((count) => count >= 10),
	`All eight parametric-stereo programs produce PCM: ${frames}`,
);
console.log(`HD Radio native memory regression passed (${module.HEAPF32.byteLength / 1048576} MiB WASM memory).`);
