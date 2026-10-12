import { describe, expect, it } from 'vitest';
import { createServer } from 'vite';
import path from 'node:path';
import { sourceAlias } from '../../../source-alias.mjs';

describe('ACARS package in the Vite development server', () => {
	it('resolves the public framing subpath through the receiver adapters', async () => {
		const server = await createServer({
			configFile: false,
			root: path.resolve('src/client'),
			publicDir: false,
			resolve: { alias: sourceAlias },
			server: { middlewareMode: true, watch: null, hmr: false },
			optimizeDeps: { noDiscovery: true, include: [] },
			logLevel: 'silent',
		});
		try {
			for (const entry of ['framing', 'messages']) {
				const transformed = await server.transformRequest(`/worker/decoders/acars/${entry}.ts`);
				expect(transformed?.code).toContain('@jlynx_/acars-decoder/dist/framing.js');
			}
		} finally {
			await server.close();
		}
	});
});
