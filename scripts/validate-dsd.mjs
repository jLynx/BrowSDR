// Offline DSD recording validation with the same decoder and mbelib WASM as the app.
// Usage: node scripts/validate-dsd.mjs --self-test
//        node scripts/validate-dsd.mjs --p25-self-test [0] [invert]
//        node scripts/validate-dsd.mjs path/to/iq.wav [shiftHz] [invert]
//        Add --audio-out=path.wav to inspect decoded mono PCM at 8 kHz.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { initSync, DspProcessor, alloc_float_buffer } from '../hackrf-web/pkg/hackrf_web.js';

const filename = process.argv[2];
if (!filename) throw new Error('Provide a PCM or float stereo IQ WAV recording');
const p25SelfTest = filename === '--p25-self-test';
const selfTest = filename === '--self-test' || p25SelfTest;
const wav = selfTest ? null : await readFile(filename);
let format, data;
for (let pos = 12; wav && pos + 8 <= wav.length;) {
	const size = wav.readUInt32LE(pos + 4);
	const id = wav.toString('ascii', pos, pos + 4);
	if (id === 'fmt ') format = { type: wav.readUInt16LE(pos + 8), channels: wav.readUInt16LE(pos + 10), rate: wav.readUInt32LE(pos + 12), bits: wav.readUInt16LE(pos + 22) };
	if (id === 'data') data = wav.subarray(pos + 8, pos + 8 + size);
	pos += 8 + size + (size % 2);
}
if (!selfTest && (!format || !data || format.channels !== 2 || !((format.type === 1 && [16,24].includes(format.bits)) || (format.type === 3 && format.bits === 32)))) throw new Error('Expected stereo IQ, PCM16/24 or float32 WAV');

const root = resolve(import.meta.dirname, '..');
const js = await readFile(resolve(root, 'public/lib/mbelib/mbelib.js'), 'utf8');
const wasm = await readFile(resolve(root, 'public/lib/mbelib/mbelib.wasm'));
const originalFetch = globalThis.fetch;
globalThis.self = { location: { href: 'http://localhost/lib/mbelib/mbelib.js' } };
globalThis.WorkerGlobalScope = class {};
globalThis.fetch = async (url, options) => {
	if (String(url).endsWith('/lib/mbelib/mbelib.js')) return new Response(js);
	if (String(url).endsWith('/lib/mbelib/mbelib.wasm')) return new Response(wasm, { headers: { 'Content-Type': 'application/wasm' } });
	return originalFetch(url, options);
};
const server = await createServer({ root, configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
	const { DSDDecoder } = await server.ssrLoadModule('/src/client/worker/dsd/dsd-decoder.ts');
	const { FMDiscriminator, FIRFilter, rrcTaps } = await server.ssrLoadModule('/src/client/worker/dsd/dsd-dsp.ts');
	const { ensureMbelibInitialized } = await server.ssrLoadModule('/src/client/worker/mbelib-init.ts');
	await ensureMbelibInitialized();
	let iq;
	if (p25SelfTest) {
		format = { type: 3, channels: 2, rate: 48000, bits: 32 };
		const vectors = JSON.parse(await readFile(resolve(root, 'test/fixtures/p25-vectors.json'), 'utf8'));
		// Real mbelib receives an independently encoded MMDVM null IMBE vector.
		const { extractP25IMBE } = await server.ssrLoadModule('/src/client/worker/dsd/dsd-p25.ts');
		const { decodeImbe, getMbeErrors, resetMbe } = await server.ssrLoadModule('/src/client/worker/mbelib-init.ts');
		const voice = Uint8Array.from({ length: 72 }, (_, i) => parseInt(vectors.imbe[i >> 1], 16) >> (i % 2 ? 0 : 2) & 3);
		decodeImbe(extractP25IMBE(voice, 0));
		if (getMbeErrors() !== 0) throw new Error('Known IMBE codec vector failed');
		resetMbe();
		// A warm-up terminator, header and twenty alternating LDUs, without gaps.
		const packets = [vectors.frames.tdu, vectors.frames.hdu];
		for (let i = 0; i < 20; i++) packets.push(vectors.frames[i % 2 ? 'ldu2' : 'ldu1']);
		// Give the timing loop and adaptive slicer a carrier before the first unit.
		let seed = 123456789;
		const preamble = Array.from({ length: 2000 }, () => {
			seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
			return seed & 3;
		}).join('');
		const dibits = Uint8Array.from(preamble + packets.join(''), Number);
		const impulses = new Float32Array(dibits.length * 10 + 400);
		for (let i = 0; i < dibits.length; i++) impulses[i * 10] = [1,3,-1,-3][dibits[i]] * 0.25;
		const shaped = new Float32Array(impulses.length);
		new FIRFilter(rrcTaps(65,48000,4800,0.2)).process(impulses,shaped);
		let phase = 0;
		iq = new Float32Array(shaped.length * 2);
		for (let i = 0; i < shaped.length; i++) {
			phase += shaped[i]; iq[2*i] = Math.cos(phase); iq[2*i+1] = Math.sin(phase);
		}
	} else if (selfTest) {
		format = { type: 3, channels: 2, rate: 48000, bits: 32 };
		// Independent AMBE silence vector from MMDVMHost/DMRDefines.h.
		const bytes = [0xb9,0xe8,0x81,0x52,0x61,0x73,0x00,0x2a,0x6b,0xb9,0xe8,0x81,0x52,0x60,0,0,0,0,0,1,0x73,0,0x2a,0x6b,0xb9,0xe8,0x81,0x52,0x61,0x73,0,0x2a,0x6b];
		const payload = Uint8Array.from({ length: 132 }, (_, i) => (bytes[i >> 2] >> (6 - 2 * (i % 4))) & 3);
		const { processDMRSingleBurst } = await server.ssrLoadModule('/src/client/worker/dsd/dsd-dmr.ts');
		const { decodeAmbe, getMbeErrors, resetMbe } = await server.ssrLoadModule('/src/client/worker/mbelib-init.ts');
		const voice = new Uint8Array(108); voice.set(payload.subarray(0,54)); voice.set(payload.subarray(78),54);
		for (const frame of processDMRSingleBurst(voice,0,{})) {
			decodeAmbe(frame);
			if (getMbeErrors() !== 0) throw new Error('Known AMBE codec vector failed');
		}
		resetMbe();
		const dibits = new Uint8Array(144 * 120);
		const { SYNC_WORDS } = await server.ssrLoadModule('/src/client/worker/dsd/types.ts');
		for (let burst = 0; burst < 120; burst++) {
			dibits.set(payload, burst * 144 + 12);
			if (burst % 12 === 0) dibits.set(Uint8Array.from(SYNC_WORDS.DMR_BS_VOICE, Number), burst * 144 + 66);
			if (burst % 2 === 1) dibits.set(Uint8Array.from(SYNC_WORDS.DMR_BS_DATA, Number), burst * 144 + 66);
		}
		const impulses = new Float32Array(dibits.length * 10 + 100);
		for (let i = 0; i < dibits.length; i++) impulses[i * 10] = [1,3,-1,-3][dibits[i]] * 0.25;
		const shaped = new Float32Array(impulses.length);
		new FIRFilter(rrcTaps(65,48000,4800,0.2)).process(impulses,shaped);
		let phase = 0;
		iq = new Float32Array(shaped.length * 2);
		for (let i = 0; i < shaped.length; i++) {
			phase += shaped[i];
			iq[2*i] = Math.cos(phase); iq[2*i+1] = Math.sin(phase);
		}
	} else {
		const values = data.length / (format.bits / 8);
		iq = Float32Array.from({ length: values }, (_, i) => format.type === 3 ? data.readFloatLE(i * 4)
			: format.bits === 24 ? data.readIntLE(i * 3, 3) / 8388608 : data.readInt16LE(i * 2) / 32768);
	}
	const shift = Number(process.argv[3] ?? 0);
	const dspWasm = initSync({ module: await readFile(resolve(root, 'hackrf-web/pkg/hackrf_web_bg.wasm')) });
	const ddc = new DspProcessor(format.rate, shift, 12500);
	ddc.set_if_sample_rate(48000);
	const inputPtr = alloc_float_buffer(iq.length);
	new Float32Array(dspWasm.memory.buffer, inputPtr, iq.length).set(iq);
	const outputPtr = ddc.process_iq_only_f32_ptr(inputPtr, iq.length);
	const filteredIq = new Float32Array(dspWasm.memory.buffer, outputPtr, ddc.get_iq_output_len()).slice();
	const discriminator = new FMDiscriminator();
	const baseband = new Float32Array(filteredIq.length / 2);
	discriminator.process(filteredIq, baseband);
	if (process.argv[4] === 'invert') for (let i = 0; i < baseband.length; i++) baseband[i] = -baseband[i];
	let samples = 0, peak = 0, status, modes = new Set(), errors = {}, syncs = {};
	const audioOutput = process.argv.find(arg => arg.startsWith('--audio-out='))?.slice('--audio-out='.length);
	const audioChunks = [];
	let lastP25Status;
	const decoder = new DSDDecoder(audio => {
		samples += audio.length;
		if (audioOutput) audioChunks.push(audio.slice());
		for (const value of audio) peak = Math.max(peak, Math.abs(value));
	}, next => {
		status = next;
		if (next.mode === 'p25' && next.synced) lastP25Status = next;
		if (next.synced) modes.add(next.mode);
		if (next.syncName) syncs[next.syncName] = (syncs[next.syncName] || 0) + 1;
		if (next.mbeErrors) errors[next.mbeErrors] = (errors[next.mbeErrors] || 0) + 1;
	});
	await ensureMbelibInitialized();
	for (let offset = 0; offset < baseband.length; offset += 1567) decoder.process(baseband.subarray(offset, offset + 1567));
	console.log(JSON.stringify({ format, shift, durationSeconds: iq.length / 2 / format.rate, modes: [...modes], audioSamples: samples, peak, status, lastP25Status, syncs, errors }, null, 2));
	if (audioOutput) {
		const output = Buffer.alloc(44 + samples * 2);
		output.write('RIFF', 0); output.writeUInt32LE(output.length - 8, 4); output.write('WAVEfmt ', 8);
		output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
		output.writeUInt32LE(8000, 24); output.writeUInt32LE(16000, 28);
		output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
		output.write('data', 36); output.writeUInt32LE(samples * 2, 40);
		let offset = 44;
		for (const chunk of audioChunks) for (const sample of chunk) {
			output.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), offset); offset += 2;
		}
		await writeFile(audioOutput, output);
	}
	if (p25SelfTest && (modes.size !== 1 || !modes.has('p25') || samples !== 28800 ||
		status.voiceFrameCount !== 180 || status.nac !== 0x293 || status.tg !== 0x1234 ||
		status.algid !== 0x80 || Object.keys(errors).some(bar => /[EX]/.test(bar)))) {
		throw new Error('P25 RF-to-codec self-test failed');
	}
	if (selfTest && !p25SelfTest && (modes.size !== 1 || !modes.has('dmr') || samples !== 25600 ||
		status.voiceFrameCount !== 160 || peak > 0.002 || Object.keys(errors).some(bar => /[EX]/.test(bar)))) {
		throw new Error('DMR RF-to-codec self-test failed');
	}
} finally {
	await server.close();
	globalThis.fetch = originalFetch;
}
