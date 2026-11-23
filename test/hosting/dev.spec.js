import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';

describe('development hosting', () => {
	it('uses a command-line base for public WASM, transcription and API proxies', async () => {
		const server = await createServer({ base: '/sdr/', server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
		try {
			await server.listen();
			const origin = server.resolvedUrls.local[0];
			for (const decoder of ['dsp/browsdr_dsp_bg', 'rtl433/rtl433', 'mbelib/mbelib', 'nrsc5/nrsc5']) {
				const response = await fetch(new URL(`wasm/${decoder}.wasm`, origin));
				expect(response.status).toBe(200);
				expect(response.headers.get('Content-Type')).toBe('application/wasm');
			}
			const whisper = await fetch(new URL('transcription/whisper-worker.ts', origin));
			expect(whisper.status).toBe(200);
			expect(await whisper.text()).toContain('hf-proxy');
			for (const route of ['api', 'hf-proxy']) {
				const proxy = server.config.server.proxy[`/sdr/${route}`];
				expect(proxy.target).toBe('http://localhost:8788');
				expect(proxy.rewrite(`/sdr/${route}/file?x=1`)).toBe(`/${route}/file?x=1`);
			}
		} finally {
			await server.close();
		}
	}, 30000);
});
