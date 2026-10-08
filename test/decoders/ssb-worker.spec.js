import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dspModule = readFileSync(new URL('../../hackrf-web/pkg/hackrf_web_bg.wasm', import.meta.url));

vi.mock('/hackrf-web/pkg/hackrf_web.js', async () => {
	const dsp = await vi.importActual('../../hackrf-web/pkg/hackrf_web.js');
	const wasm = dsp.initSync({ module: dspModule });
	return { ...dsp, default: async () => wasm };
});

afterEach(() => vi.unstubAllGlobals());

async function createReceiver(mode, bandwidth = 2800) {
	vi.resetModules();
	const messages = [];
	vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
	await import('../../src/client/worker/dsp-worker');
	const params = { freq: 7.1, mode, bandwidth, enabled: true, squelchEnabled: false };
	const send = (data) => self.onmessage({ data });
	await send({ type: 'init', sampleRate: 2000000, centerFreq: 7, params });
	return { params, send, messages };
}

async function receive(receiver, { floatIq = false, centerFreq = 7, sampleRate = 2000000, sizes = [65536], seconds = 0.4 } = {}) {
	const audio = [];
	const side = receiver.params.mode === 'lsb' ? -1 : 1;
	const count = Math.round(sampleRate * seconds);
	let offset = 0;
	let chunkIndex = 0;
	while (offset < count) {
		const size = Math.min(sizes[chunkIndex++ % sizes.length], count - offset);
		const input = floatIq ? new Float32Array(size * 2) : new Int8Array(size * 2);
		// Wanted tones span the voice passband, including above the old BW/2
		// cutoff. A stronger interferer is on the opposite side of the carrier.
		const tones = [
			[side * 500, 0.12],
			[side * 2300, 0.12],
			[-side * 1100, 0.25],
		];
		for (let i = 0; i < size; i++) {
			let re = 0,
				im = 0;
			for (const [tone, amplitude] of tones) {
				const phase = (2 * Math.PI * ((receiver.params.freq - centerFreq) * 1e6 + tone) * (offset + i)) / sampleRate;
				re += amplitude * Math.cos(phase);
				im += amplitude * Math.sin(phase);
			}
			input[2 * i] = floatIq ? re : Math.round(re * 127);
			input[2 * i + 1] = floatIq ? im : Math.round(im * 127);
		}
		await receiver.send({
			type: 'process',
			params: receiver.params,
			sampleRate,
			centerFreq,
			floatIq,
			chunkLen: input.length,
			chunk: input.buffer,
		});
		const message = receiver.messages.at(-1);
		expect(message.type).toBe('audio');
		if (message.samples) audio.push(new Float32Array(message.samples));
		offset += size;
	}
	const result = new Float32Array(audio.reduce((sum, block) => sum + block.length, 0));
	let position = 0;
	for (const block of audio) {
		result.set(block, position);
		position += block.length;
	}
	return result;
}

function toneAmplitude(audio, frequency) {
	// Use the settled last 0.1 seconds, an integer number of all test tones.
	const tail = audio.subarray(audio.length - 4800);
	let re = 0,
		im = 0;
	for (let i = 0; i < tail.length; i++) {
		const phase = (2 * Math.PI * frequency * i) / 48000;
		re += tail[i] * Math.cos(phase);
		im += tail[i] * Math.sin(phase);
	}
	return (2 * Math.hypot(re, im)) / tail.length;
}

function expectSidebandAudio(audio) {
	expect(audio.length).toBeGreaterThanOrEqual(19000);
	expect(audio.every(Number.isFinite)).toBe(true);
	const low = toneAmplitude(audio, 500);
	const high = toneAmplitude(audio, 2300);
	expect(low).toBeGreaterThan(0.05);
	expect(high / low).toBeGreaterThan(0.8);
	expect(high / low).toBeLessThan(1.2);
	// At least 40 dB rejection, despite the interferer being twice as strong.
	expect(toneAmplitude(audio, 1100) / low).toBeLessThan(0.01);
	// The old path shifted voice frequencies by BW/2 instead of restoring them.
	expect(toneAmplitude(audio, 1900) / low).toBeLessThan(0.01);
}

describe('SSB through the actual WASM DDC and DSP worker', () => {
	it.each(['usb', 'lsb'])('%s recovers voice pitch and rejects the opposite sideband from byte IQ', async (mode) => {
		expectSidebandAudio(await receive(await createReceiver(mode)));
	});
	it.each(['usb', 'lsb'])('%s works with shared float IQ and irregular USB chunk boundaries', async (mode) => {
		expectSidebandAudio(await receive(await createReceiver(mode), { floatIq: true, sampleRate: 1920000, sizes: [1567, 3133, 65536] }));
	});
	it.each(['usb', 'lsb'])('%s preserves sideband selection after input center retuning', async (mode) => {
		const receiver = await createReceiver(mode);
		await receive(receiver);
		expectSidebandAudio(await receive(receiver, { centerFreq: 7.05 }));
	});
	it('switches USB/LSB at the same IF rate and changes bandwidth after shared input', async () => {
		const receiver = await createReceiver('usb');
		await receive(receiver, { floatIq: true, sampleRate: 1920000 });
		receiver.params = { ...receiver.params, mode: 'lsb', bandwidth: 3000 };
		await receiver.send({ type: 'configure', centerFreq: 7, params: receiver.params });
		expectSidebandAudio(await receive(receiver, { floatIq: true, sampleRate: 1920000 }));
	});
});
