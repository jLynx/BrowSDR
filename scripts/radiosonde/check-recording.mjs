import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// Replay FM-demodulated audio as complex phase without changing its waveform.
// This checks the production IQ decoder; it does not simulate live reception.
function pcm(wav) {
	let format;
	let data;
	if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected PCM WAV');
	for (let offset = 12; offset + 8 <= wav.length;) {
		const length = wav.readUInt32LE(offset + 4);
		const block = wav.subarray(offset + 8, offset + 8 + length);
		const type = wav.toString('ascii', offset, offset + 4);
		if (type === 'fmt ') format = block;
		if (type === 'data') data = block;
		offset += 8 + length + (length & 1);
	}
	if (!format || !data || format.length < 16) throw new Error('Missing WAV format or data');
	const bits = format.readUInt16LE(14);
	if (format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 || format.readUInt32LE(4) !== 48000 || ![8, 16].includes(bits))
		throw new Error('Expected mono 48 kHz, 8-bit or 16-bit PCM audio');
	const samples = new Float32Array(data.length / (bits / 8));
	for (let index = 0; index < samples.length; index++)
		samples[index] = bits === 8 ? (data[index] - 128) / 128 : data.readInt16LE(index * 2) / 32768;
	return samples;
}

const paths = process.argv.slice(2);
if (!paths.length) throw new Error('Usage: node scripts/radiosonde/check-recording.mjs recording.wav [recording.wav ...]');
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createServer({
	configFile: false,
	root,
	cacheDir: resolve(root, '.cache/radiosonde/vite'),
	optimizeDeps: { noDiscovery: true, include: [] },
	server: { middlewareMode: true, watch: null },
	appType: 'custom',
});
try {
	const { RadiosondeDemodulator } = await server.ssrLoadModule('/src/client/worker/decoders/radiosonde/demodulator.ts');
	const { SondeTracker } = await server.ssrLoadModule('/src/client/worker/decoders/radiosonde/tracker.ts');
	for (const path of paths) {
		const samples = pcm(await readFile(path));
		const tracker = new SondeTracker();
		let syncs = 0;
		let phase = 0;
		let time = 0;
		const decoder = new RadiosondeDemodulator(
			(frame) => tracker.process(frame, 403, time),
			() => syncs++,
		);
		for (let offset = 0; offset < samples.length; offset += 4096) {
			time = 1000 + (offset * 1000) / 48000;
			const iq = new Float32Array(Math.min(4096, samples.length - offset) * 2);
			for (let index = 0; index < iq.length / 2; index++) {
				phase += samples[offset + index] * 0.5;
				iq[index * 2] = Math.cos(phase);
				iq[index * 2 + 1] = Math.sin(phase);
			}
			decoder.process(iq);
		}
		const sondes = tracker.snapshot(time).map(({ trail: _trail, ...sonde }) => sonde);
		console.log(JSON.stringify({ recording: path, syncs, validFrames: tracker.frames, sondes }, null, 2));
		if (!tracker.frames || !sondes.some((sonde) => sonde.latitude !== undefined)) process.exitCode = 1;
	}
} finally {
	await server.close();
}
