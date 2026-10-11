import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharedBandPool } from '@/worker/streams/shared-band-pool';

const binary = readFileSync(new URL('../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url));
vi.mock('/wasm/dsp/browsdr_dsp.js', async () => {
	const dsp = await vi.importActual('../../wasm/dsp/pkg/browsdr_dsp.js');
	const wasm = dsp.initSync({ module: binary });
	return { ...dsp, default: async () => wasm };
});
afterEach(() => vi.unstubAllGlobals());

async function receiver() {
	vi.resetModules();
	const messages = [];
	vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
	await import('@/worker/dsp-worker');
	return { messages, send: (data) => self.onmessage({ data }) };
}

describe('live DSP reconfiguration with real WASM', () => {
	it.each([
		{ freq: 131.55, mode: 'nfm', bandwidth: 12500, enabled: false, acars: true, squelchEnabled: false },
		{ freq: 121.475, mode: 'am', bandwidth: 10000, enabled: true, squelchEnabled: true },
		{ freq: 124.3, mode: 'nfm', bandwidth: 12500, enabled: true, squelchEnabled: true },
	])('processes valid pooled samples for $mode at $freq MHz (audio enabled: $enabled)', async (vfo) => {
		const rx = await receiver();
		const params = {
			...vfo,
			squelchLevel: -100,
			deEmphasis: 'none',
			lowPass: true,
		};
		await rx.send({ type: 'init', sampleRate: 61440000, centerFreq: 131, params });
		const pool = new SharedBandPool();
		const large = pool.copy([{ centerBin: 0, samples: new Float32Array(60000).fill(NaN) }]);
		pool.release(large.batchId);
		for (const length of [38400, 8192, 38400]) {
			const samples = new Float32Array(length);
			for (let i = 0; i < length / 2; i++) {
				const phase = (2 * Math.PI * (100000 + 2000 * Math.sin((2 * Math.PI * 1000 * i) / 1920000)) * i) / 1920000;
				samples[2 * i] = 0.05 * Math.cos(phase);
				samples[2 * i + 1] = 0.05 * Math.sin(phase);
			}
			const batch = pool.copy([{ centerBin: 0, samples }]);
			const band = batch.bands[0];
			expect(band.buffer.byteLength).toBeGreaterThan(samples.byteLength);
			await rx.send({
				type: 'process',
				params,
				floatIq: true,
				sampleRate: 1920000,
				centerFreq: params.freq - 0.1,
				chunk: band.buffer,
				chunkLen: band.length,
				chunkId: batch.batchId,
			});
			const output = rx.messages.at(-1);
			expect(output.type).toBe('audio');
			if (params.enabled) expect(new Float32Array(output.samples).length).toBeGreaterThan(0);
			expect(new Float32Array(output.samples).every(Number.isFinite)).toBe(true);
			pool.release(batch.batchId);
		}
	});
	it('matches FM squelch to queued input parameters when a newer configure event arrives first', async () => {
		const rx = await receiver();
		const params = {
			freq: 121.475,
			mode: 'nfm',
			bandwidth: 12500,
			enabled: true,
			squelchEnabled: true,
			squelchLevel: -100,
			deEmphasis: 'none',
		};
		await rx.send({ type: 'init', sampleRate: 1920000, centerFreq: 121.36, params });
		const closed = { ...params, squelchLevel: 0 };
		await rx.send({ type: 'configure', centerFreq: 130, params: closed });
		const input = new Float32Array(38400);
		for (let i = 0; i < input.length / 2; i++) {
			const phase = (2 * Math.PI * (115000 + 2000 * Math.sin((2 * Math.PI * 1000 * i) / 1920000)) * i) / 1920000;
			input[i * 2] = 0.05 * Math.cos(phase);
			input[i * 2 + 1] = 0.05 * Math.sin(phase);
		}
		for (const snapshot of [params, closed]) {
			for (let i = 0; i < 3; i++)
				await rx.send({
					type: 'process',
					params: snapshot,
					floatIq: true,
					sampleRate: 1920000,
					centerFreq: 121.36,
					chunk: input.buffer,
					chunkLen: input.length,
					chunkId: i,
				});
			const audio = new Float32Array(rx.messages.at(-1).samples);
			expect(audio.some((value) => Math.abs(value) > 0.001)).toBe(snapshot === params);
		}
	});
	it('keeps shared output bounded across retuning and only reuses acknowledged buffers', async () => {
		const rx = await receiver();
		const buffers = new Set();
		for (let i = 0; i < 180; i++) {
			const centers = [(i % 4) * 128, -128];
			await rx.send({
				type: 'channelize',
				key: `${centers}`,
				ratio: 32,
				centers,
				sampleRate: 1920000,
				chunk: new Int8Array(261120).buffer,
				inputSamples: 130560,
				chunkId: i,
			});
			const output = rx.messages.at(-1);
			expect(output.type).toBe('bands');
			for (const band of output.bands) {
				buffers.add(band.buffer);
				expect(new Float32Array(band.buffer, 0, band.length).every(Number.isFinite)).toBe(true);
			}
			if (output.batchId !== undefined) await rx.send({ type: 'release_bands', batchId: output.batchId });
		}
		expect(buffers.size).toBeLessThanOrEqual(2);
	});
	it('restores AM squelch after DSD/NFM changes, muting, and shared/direct rate switches', async () => {
		const rx = await receiver();
		const params = { freq: 121.475, mode: 'am', bandwidth: 10000, enabled: true, squelchEnabled: true, squelchLevel: 0 };
		await rx.send({ type: 'init', sampleRate: 61440000, centerFreq: 130, params });
		for (const mode of ['dsd', 'nfm', 'am']) await rx.send({ type: 'configure', centerFreq: 130, params: { ...params, mode } });
		await rx.send({ type: 'configure', centerFreq: 130, params: { ...params, enabled: false } });
		await rx.send({ type: 'configure', centerFreq: 130, params });
		for (const [rate, center, floatIq] of [
			[1920000, 121.36, true],
			[61440000, 130, false],
			[1920000, 121.36, true],
		]) {
			for (let block = 0; block < 10; block++) {
				const input = floatIq ? new Float32Array(38400) : new Int8Array(261120);
				for (let i = 0; i < input.length / 2; i++) {
					const phase = (2 * Math.PI * ((params.freq - center) * 1e6) * i) / rate;
					const amplitude = (floatIq ? 0.05 : 6) * (1 + 0.2 * Math.sin((2 * Math.PI * 1000 * i) / rate));
					input[2 * i] = amplitude * Math.cos(phase);
					input[2 * i + 1] = amplitude * Math.sin(phase);
				}
				await rx.send({
					type: 'process',
					params,
					sampleRate: rate,
					centerFreq: center,
					floatIq,
					chunk: input.buffer,
					chunkLen: input.length,
					chunkId: block,
				});
				const output = rx.messages.at(-1);
				expect(output.type).toBe('audio');
				expect(output.squelchOpen).toBe(false);
				expect(Number.isFinite(output.squelchDb)).toBe(true);
				expect(new Float32Array(output.samples).every((value) => value === 0)).toBe(true);
				if (block === 9) {
					const open = { ...params, squelchLevel: -100 };
					await rx.send({ type: 'configure', centerFreq: 130, params: open });
					await rx.send({
						type: 'process',
						params: open,
						sampleRate: rate,
						centerFreq: center,
						floatIq,
						chunk: input.buffer,
						chunkLen: input.length,
						chunkId: 10,
					});
					const audio = rx.messages.at(-1);
					expect(audio.squelchOpen).toBe(true);
					expect(new Float32Array(audio.samples).some((value) => Math.abs(value) > 0.00001)).toBe(true);
					await rx.send({ type: 'configure', centerFreq: 130, params });
				}
			}
		}
	});
});
