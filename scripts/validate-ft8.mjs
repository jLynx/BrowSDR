import fs from 'node:fs';
import assert from 'node:assert/strict';
import createModule from '../public/lib/ft8/decoder.js';

const wasm = await createModule({ print: () => {} });
wasm._ft8_init();
const recording = fs.readFileSync(new URL('../test/fixtures/ft8/websdr_test1.wav', import.meta.url));
const audio = new Float32Array(180000);
let sampleRate = 0;
for (let pos = 12; pos + 8 <= recording.length;) {
	const id = recording.toString('ascii', pos, pos + 4);
	const length = recording.readUInt32LE(pos + 4);
	if (id === 'fmt ') {
		assert.equal(recording.readUInt16LE(pos + 8), 1);
		assert.equal(recording.readUInt16LE(pos + 10), 1);
		sampleRate = recording.readUInt32LE(pos + 12);
		assert.equal(recording.readUInt16LE(pos + 22), 16);
	}
	if (id === 'data') for (let i = 0; i < Math.min(length / 2, audio.length); i++) audio[i] = recording.readInt16LE(pos + 8 + i * 2) / 32768;
	pos += 8 + length + (length % 2);
}
assert.equal(sampleRate, 12000);
const ptr = wasm._malloc(audio.byteLength);
const decode = samples => {
	wasm.HEAPF32.set(samples, ptr / 4);
	const count = wasm._ft8_decode(ptr, samples.length);
	const result = wasm._ft8_results();
	return Array.from({ length: count }, (_, i) => {
		const offset = result + i * 52;
		const bytes = wasm.HEAPU8.subarray(offset + 12, offset + 52);
		return { sync: wasm.HEAPF32[offset / 4], dt: wasm.HEAPF32[offset / 4 + 1], hz: wasm.HEAPF32[offset / 4 + 2], text: new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0))) };
	});
};
const messages = decode(audio);
const expected = messages.find(message => message.text === 'CQ IK4LZH JN54');
assert.ok(expected, 'Decode the independently recorded FT8 message');
assert.ok(Math.abs(expected.hz - 1109) < 7, 'Recover its audio frequency');
assert.ok(messages.length >= 10, 'Decode multiple simultaneous stations');
assert.equal(decode(new Float32Array(180000)).length, 0, 'Silence must not produce messages');
for (let i = 0; i < 4; i++) assert.ok(decode(audio).some(message => message.text === expected.text), 'Repeated slots remain decodable');
assert.equal(wasm._ft8_decode(ptr, 10), -1, 'Reject truncated frames');
wasm._free(ptr);
console.log('FT8 WASM validation passed:', messages);
