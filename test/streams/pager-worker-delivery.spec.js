import { beforeAll, describe, expect, it } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { build } from 'vite';
import * as Comlink from 'comlink';
import { sourceAlias } from '../../source-alias.mjs';

let decodeLocalPager;

beforeAll(async () => {
	// Use Vite's production target and minifier: dev execution leaves optional
	// method calls intact and cannot reproduce the Comlink .call regression.
	const result = await build({
		configFile: false,
		resolve: { alias: sourceAlias },
		logLevel: 'silent',
		build: {
			write: false,
			lib: { entry: 'src/client/worker/streams/local-audio.ts', formats: ['es'] },
			minify: true,
		},
	});
	const chunk = result[0].output.find((output) => output.type === 'chunk' && output.isEntry);
	const bundled = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
	decodeLocalPager = bundled.decodeLocalPager;
});

describe('production pager delivery over Comlink', () => {
	it.each(['pocsag', 'gsc', 'flex'])('delivers %s messages and status without cloning callbacks', async (protocol) => {
		const { port1, port2 } = new MessageChannel();
		const received = [];
		let resolveDelivery;
		const delivered = new Promise((resolve) => (resolveDelivery = resolve));
		Comlink.expose((...args) => {
			received.push(args);
			if (received.length === 2) resolveDelivery();
		}, port1);
		const callback = Comlink.wrap(port2);
		const pager = { [protocol]: callback, [`${protocol}Status`]: callback };
		const params = { freq: 157.95, mode: 'nfm', [protocol]: true };
		const state = {};
		let timeout;
		try {
			decodeLocalPager(pager, params, state, 0, new Float32Array(0), protocol);
			const decoder = state[`${protocol}Decoder`];
			// Trigger the real decoder's message callback; waveform decoding is
			// covered separately. This exercises the worker-to-UI transport.
			const message = { text: 'Production delivery test', capcode: 12345 };
			const emitter = protocol === 'pocsag' ? decoder._d2400 : decoder;
			emitter.onMessage(message);
			await Promise.race([
				delivered,
				new Promise((_, reject) => {
					timeout = setTimeout(() => reject(new Error('Pager message delivery timed out')), 2000);
				}),
			]);
			expect(received).toEqual([
				[0, params.freq, decoder.getStatus()],
				[0, params.freq, message],
			]);
		} finally {
			clearTimeout(timeout);
			port1.close();
			port2.close();
		}
	});
});
