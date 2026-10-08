import fs from 'node:fs';
import assert from 'node:assert/strict';
import Rtl433Module from '../public/lib/rtl433/rtl433.js';

const args = process.argv.slice(2);
const file = args[0];
if (!file) throw new Error('Usage: node scripts/validate-rtl433.mjs capture.cu8 [--rate 250000] [--freq 433920000] [--protocols 40,41]');
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const bytes = fs.readFileSync(file);
assert.equal(bytes.length % 2, 0, 'Expected interleaved unsigned 8-bit IQ');
const rate = Number(option('--rate', '250000'));
const freq = Number(option('--freq', '433920000'));
const ids = option('--protocols', '');
async function decode(blockValues) {
	const events = [];
	const module = await Rtl433Module({
		wasmBinary: fs.readFileSync(new URL('../public/lib/rtl433/rtl433.wasm', import.meta.url)),
		onDecoded: json => events.push(JSON.parse(json)),
		print: () => {}, printErr: () => {},
	});
	const idsPtr = module.stringToNewUTF8(ids);
	const active = module._rtl433_init(rate, freq, idsPtr);
	module._free(idsPtr);
	assert(active > 0, 'No protocols loaded');
	const ptr = module._malloc(blockValues * 4);
	const start = performance.now();
	for (let offset = 0; offset < bytes.length; offset += blockValues) {
		const count = Math.min(blockValues, bytes.length - offset);
		for (let i = 0; i < count; i++) module.HEAPF32[ptr / 4 + i] = (bytes[offset + i] - 128) / 128;
		assert(module._rtl433_process(ptr, count) >= 0);
	}
	module._rtl433_flush();
	const elapsedMs = performance.now() - start;
	module._free(ptr);
	module._rtl433_destroy();
	return { events, active, elapsedMs, memoryBytes: module.HEAPF32.byteLength };
}
const result = await decode(65536);
assert(result.events.length > 0, 'Capture did not produce decoded events');
const split = await decode(1024);
assert.deepEqual(split.events, result.events, 'Payloads changed at streaming block boundaries');
console.log(JSON.stringify({ file, rate, freq, ...result, rfDurationMs: bytes.length / 2 / rate * 1000 }, null, 2));
