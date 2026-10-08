import { sourceAlias } from './source-alias.mjs';
import { defineConfig, build, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import fs from 'fs';

// Plugin that runs after the main build to:
// 1. Bundle the dsp-worker properly (Vite doesn't bundle nested workers)
// 2. Copy WASM files to dist
// 3. Fix .ts → .js extensions in output filenames and references
function postBuildPlugin(): Plugin {
	return {
		name: 'post-build',
		async closeBundle() {
			const distDir = path.resolve(__dirname, 'dist');
			const assetsDir = path.join(distDir, 'assets');

			// Track all .ts → .js renames for reference updates
			const renames = new Map<string, string>();

			// --- Bundle nested workers (Vite doesn't bundle workers spawned from workers) ---
			for (const file of fs.readdirSync(assetsDir)) {
				const filePath = path.join(assetsDir, file);
				if (!file.endsWith('.ts') && !file.endsWith('.js')) continue;

				const content = fs.readFileSync(filePath, 'utf-8');
				if (content.includes("from './") || content.includes("from '../") || content.includes("from '@/")) {
					console.log(`[post-build] Bundling nested worker: ${file}`);
					const jsName = file.replace(/\.ts$/, '.js');
					renames.set(file, jsName);

					await build({
						configFile: false,
						root: path.resolve(__dirname, 'src/client'),
						build: {
							outDir: assetsDir,
							emptyOutDir: false,
							lib: {
								entry: path.resolve(__dirname, 'src/client/worker/dsp-worker.ts'),
								formats: ['es'],
								fileName: () => jsName,
							},
							rollupOptions: {
								external: [/^\/wasm\//],
							},
							minify: true,
						},
						resolve: {
							alias: sourceAlias,
						},
						logLevel: 'warn',
					});

					// Remove the unbundled original .ts if it differs from the output
					if (file !== jsName && fs.existsSync(filePath)) {
						fs.unlinkSync(filePath);
					}
				}
			}

			// --- Rename any remaining .ts output files to .js ---
			for (const file of fs.readdirSync(assetsDir)) {
				if (file.endsWith('.ts')) {
					const jsName = file.replace(/\.ts$/, '.js');
					renames.set(file, jsName);
					fs.renameSync(path.join(assetsDir, file), path.join(assetsDir, jsName));
				}
			}

			// --- Update all .ts → .js references in output files ---
			updateBuiltReferences(renames, assetsDir, distDir);

			// --- Bundle whisper-worker (loaded via plain URL, not Vite worker syntax) ---
			const whisperEntry = path.resolve(__dirname, 'src/client/transcription/whisper-worker.ts');
			if (fs.existsSync(whisperEntry)) {
				console.log('[post-build] Bundling whisper-worker');
				await build({
					resolve: { alias: sourceAlias },
					configFile: false,
					root: path.resolve(__dirname, 'src/client'),
					build: {
						outDir: distDir,
						emptyOutDir: false,
						lib: {
							entry: whisperEntry,
							formats: ['es'],
							fileName: () => 'whisper-worker.js',
						},
						rollupOptions: {
							external: [
								/^https?:\/\//, // CDN imports stay external
							],
						},
						minify: true,
					},
					logLevel: 'warn',
				});
			}

			// --- Copy WASM files ---
			copyDecoderAssets(distDir);
		},
	};
}

export default defineConfig({
	root: 'src/client',
	build: {
		outDir: path.resolve(__dirname, 'dist'),
		emptyOutDir: true,
		rollupOptions: {
			external: [/^\/wasm\//],
		},
	},
	worker: {
		format: 'es',
		rollupOptions: {
			external: [/^\/wasm\//],
		},
	},
	plugins: [
		wasmAssetsPlugin(),
		VitePWA({
			registerType: 'autoUpdate',
			injectRegister: 'script',
			workbox: {
				skipWaiting: true,
				clientsClaim: true,
				globPatterns: ['**/*.{js,css,html,wasm}'],
				navigateFallback: null,
				runtimeCaching: [
					{
						// API routes: network-first (only works online)
						urlPattern: /^.*\/api\/.*/i,
						handler: 'NetworkFirst',
						options: {
							cacheName: 'api-cache',
							networkTimeoutSeconds: 5,
							expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 },
						},
					},
				],
			},
			manifest: {
				name: 'BrowSDR – Web SDR Receiver',
				short_name: 'BrowSDR',
				description: 'A blazing-fast browser-based Software Defined Radio receiver.',
				theme_color: '#0f0f1a',
				background_color: '#0f0f1a',
				display: 'standalone',
				start_url: '/',
				icons: [
					{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
				],
			},
		}),
		postBuildPlugin(),
	],
	publicDir: path.resolve(__dirname, 'public'),
	define: {
		__VUE_OPTIONS_API__: true,
		__VUE_PROD_DEVTOOLS__: false,
		__VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
	},
	resolve: {
		alias: {
			...sourceAlias,
			vue: 'vue/dist/vue.esm-bundler.js',
		},
	},
	server: {
		proxy: {
			'/api': 'http://localhost:8787',
			'/hf-proxy': 'http://localhost:8787',
		},
	},
});

const wasmAssets = {
	dsp: ['browsdr_dsp.js', 'browsdr_dsp_bg.wasm'],
	mbelib: ['mbelib.js', 'mbelib.wasm', 'COPYRIGHT', 'NOTICE'],
	rtl433: ['rtl433.js', 'rtl433.wasm', 'COPYING', 'NOTICE'],
};

function copyDecoderAssets(distDir: string) {
	for (const [module, files] of Object.entries(wasmAssets)) {
		const source = path.resolve(__dirname, 'wasm', module, 'pkg');
		const destination = path.resolve(distDir, 'wasm', module);
		fs.mkdirSync(destination, { recursive: true });
		for (const file of files) {
			if (!fs.existsSync(path.join(source, file))) {
				throw new Error(`Missing ${module} asset: ${file}. Restore wasm/${module}/pkg or run npm run build:${module}.`);
			}
			fs.copyFileSync(path.join(source, file), path.join(destination, file));
		}
	}
}

/** Serve the committed bundles unchanged, including dynamically loaded codecs. */
function wasmAssetsPlugin(): Plugin {
	return {
		name: 'wasm-assets',
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
				const match = /^\/wasm\/(dsp|mbelib|rtl433)\/([^/]+)$/.exec(pathname);
				if (!match) return next();
				const module = match[1] as keyof typeof wasmAssets;
				const file = match[2];
				if (!wasmAssets[module].includes(file)) {
					response.statusCode = 404;
					response.end();
					return;
				}
				const source = path.resolve(__dirname, 'wasm', module, 'pkg', file);
				if (!fs.existsSync(source)) {
					response.statusCode = 404;
					response.end();
					return;
				}
				response.setHeader(
					'Content-Type',
					file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'text/javascript' : 'text/plain',
				);
				response.end(fs.readFileSync(source));
			});
		},
	};
}

function updateBuiltReferences(renames: Map<string, string>, assetsDir: string, distDir: string) {
	if (renames.size > 0) {
		for (const file of fs.readdirSync(assetsDir)) {
			if (!file.endsWith('.js')) continue;
			const filePath = path.join(assetsDir, file);
			let content = fs.readFileSync(filePath, 'utf-8');
			let changed = false;
			for (const [oldName, newName] of renames) {
				if (content.includes(oldName)) {
					content = content.replaceAll(oldName, newName);
					changed = true;
				}
			}
			if (changed) fs.writeFileSync(filePath, content);
		}

		const htmlPath = path.join(distDir, 'index.html');
		if (fs.existsSync(htmlPath)) {
			let html = fs.readFileSync(htmlPath, 'utf-8');
			let changed = false;
			for (const [oldName, newName] of renames) {
				if (html.includes(oldName)) {
					html = html.replaceAll(oldName, newName);
					changed = true;
				}
			}
			if (changed) fs.writeFileSync(htmlPath, html);
		}
	}
}
