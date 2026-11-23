import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { afterEach, describe, it, expect, vi } from 'vitest';
import worker from '../../src/server';

afterEach(() => vi.unstubAllGlobals());

describe('BrowSDR worker', () => {
	it('routes the prefixed model proxy with its query and method intact', async () => {
		const fetch = vi.fn(() => Promise.resolve(new Response('model', { headers: { 'Set-Cookie': 'test=1' } })));
		vi.stubGlobal('fetch', fetch);
		const response = await worker.fetch(
			new Request('http://example.com/sdr/hf-proxy/model/file?download=true', { method: 'HEAD' }),
			{ BASE_PATH: '/sdr/' },
			createExecutionContext(),
		);
		expect(fetch.mock.calls[0][0]).toBe('https://huggingface.co/model/file?download=true');
		expect(fetch.mock.calls[0][1].method).toBe('HEAD');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(response.headers.get('Set-Cookie')).toBeNull();
	});
	it.each(['/sdr/', '/radio/sdr/'])('serves the app and APIs mounted at %s', async (base) => {
		for (const [path, body] of [
			['', '<title>BrowSDR'],
			['api/geo', '"country":"XX"'],
			['api/turn', '"iceServers":[]'],
		]) {
			const response = await worker.fetch(
				new Request(`http://example.com${base}${path}`),
				{ ASSETS: env.ASSETS, BASE_PATH: base },
				createExecutionContext(),
			);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain(body);
			expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
		}
	});

	it('redirects a mount without its trailing slash and preserves the sharing query', async () => {
		const response = await worker.fetch(
			new Request('http://example.com/sdr?connect=ABC'),
			{ BASE_PATH: '/sdr/' },
			createExecutionContext(),
		);
		expect(response.status).toBe(308);
		expect(response.headers.get('Location')).toBe('http://example.com/sdr/?connect=ABC');
	});

	it('does not handle paths outside the configured mount', async () => {
		const assets = { fetch: vi.fn() };
		for (const path of ['/', '/api/geo', '/sdr-other/']) {
			const response = await worker.fetch(
				new Request(`http://example.com${path}`),
				{ ASSETS: assets, BASE_PATH: '/sdr/' },
				createExecutionContext(),
			);
			expect(response.status).toBe(404);
		}
		expect(assets.fetch).not.toHaveBeenCalled();
	});

	it('maps asset requests and redirects back into the mount', async () => {
		const assets = { fetch: vi.fn(() => Promise.resolve(new Response(null, { status: 308, headers: { Location: '/?connect=ABC' } }))) };
		const response = await worker.fetch(
			new Request('http://example.com/sdr/index.html'),
			{ ASSETS: assets, BASE_PATH: '/sdr' },
			createExecutionContext(),
		);
		expect(assets.fetch.mock.calls[0][0].url).toBe('http://example.com/index.html');
		expect(response.headers.get('Location')).toBe('http://example.com/sdr/?connect=ABC');
	});

	it.each([
		['/', '<title>BrowSDR - Web-Based SDR Receiver</title>'],
		['/api/geo', '"country":"XX"'],
		['/api/turn', '"iceServers":[]'],
	])('serves %s in previews without database bindings or TURN secrets', async (path, body) => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request(`http://example.com${path}`), { ASSETS: env.ASSETS }, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain(body);
		expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
		expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
	});

	it('serves the frontend with cross-origin isolation headers through the handler', async () => {
		const request = new Request('http://example.com');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toMatch(/^text\/html\b/i);
		expect(await response.text()).toContain('<title>BrowSDR - Web-Based SDR Receiver</title>');
		expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
		expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
	});

	it('serves the frontend through the configured runtime', async () => {
		const response = await SELF.fetch('http://example.com');

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toMatch(/^text\/html\b/i);
		expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
		expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
		expect(await response.text()).toContain('<title>BrowSDR - Web-Based SDR Receiver</title>');
	});
});
