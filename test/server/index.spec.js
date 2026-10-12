import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../../src/server';

describe('BrowSDR worker', () => {
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
