import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

describe.sequential('production hosting builds', () => {
	it.each(['/', '/sdr/'])(
		'builds workers, decoder assets and PWA for %s',
		async (base) => {
			const output = await mkdtemp(path.join(tmpdir(), 'browsdr-hosting-'));
			try {
				await execute(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', output], {
					cwd: root,
					env: { ...process.env, VITE_BASE_PATH: base, VITE_BACKEND_URL: '/services/' },
					maxBuffer: 4 * 1024 * 1024,
				});
				const html = await readFile(path.join(output, 'index.html'), 'utf8');
				expect(html).toContain(`src="${base}assets/`);
				expect(html).toContain(`href="${base}manifest.webmanifest"`);
				const register = await readFile(path.join(output, 'registerSW.js'), 'utf8');
				expect(register).toContain(`register('${base}sw.js', { scope: '${base}' })`);
				const manifest = JSON.parse(await readFile(path.join(output, 'manifest.webmanifest'), 'utf8'));
				expect(new URL(manifest.start_url, `https://example.org${base}manifest.webmanifest`).pathname).toBe(base);
				expect(new URL(manifest.scope, `https://example.org${base}manifest.webmanifest`).pathname).toBe(base);
				for (const icon of manifest.icons) {
					expect(new URL(icon.src, `https://example.org${base}manifest.webmanifest`).pathname).toBe(base + path.basename(icon.src));
				}
				const files = await readdir(path.join(output, 'assets'));
				expect(files.some((file) => file.endsWith('.ts'))).toBe(false);
				for (const prefix of ['main-', 'dsp-worker-']) {
					const worker = await readFile(
						path.join(
							output,
							'assets',
							files.find((file) => file.startsWith(prefix)),
						),
						'utf8',
					);
					expect(worker).toContain(`"${base}wasm/dsp/browsdr_dsp.js"`);
					if (base !== '/') expect(worker).not.toMatch(/["']\/wasm\//);
				}
				for (const decoder of ['dsp', 'mbelib', 'rtl433', 'nrsc5']) {
					expect((await readdir(path.join(output, 'wasm', decoder))).some((file) => file.endsWith('.wasm'))).toBe(true);
				}
				const whisper = await readFile(path.join(output, 'whisper-worker.js'), 'utf8');
				expect(whisper).toContain('/services/');
				expect(whisper).not.toMatch(/["']\/hf-proxy/);
			} finally {
				expect(path.dirname(output)).toBe(path.resolve(tmpdir()));
				expect(path.basename(output)).toMatch(/^browsdr-hosting-/);
				await rm(output, { recursive: true, force: true });
			}
		},
		120000,
	);
});
