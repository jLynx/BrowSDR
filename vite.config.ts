import { defineConfig, type Plugin } from 'vite';
import path from 'path';
import fs from 'fs';

// Plugin to copy WASM files to dist on build
function copyWasmPlugin(): Plugin {
	return {
		name: 'copy-wasm',
		closeBundle() {
			const src = path.resolve(__dirname, 'hackrf-web/pkg');
			const dest = path.resolve(__dirname, 'dist/hackrf-web/pkg');
			if (fs.existsSync(src)) {
				fs.mkdirSync(dest, { recursive: true });
				for (const file of fs.readdirSync(src)) {
					fs.copyFileSync(path.join(src, file), path.join(dest, file));
				}
			}
		},
	};
}

export default defineConfig({
	root: 'src/client',
	build: {
		outDir: path.resolve(__dirname, 'dist'),
		emptyOutDir: true,
		rollupOptions: {
			external: [
				/\/hackrf-web\/pkg\//,
			],
		},
	},
	worker: {
		format: 'es',
		rollupOptions: {
			external: [
				/\/hackrf-web\/pkg\//,
			],
		},
	},
	plugins: [copyWasmPlugin()],
	publicDir: path.resolve(__dirname, 'public'),
	define: {
		__VUE_OPTIONS_API__: true,
		__VUE_PROD_DEVTOOLS__: false,
		__VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
	},
	resolve: {
		alias: {
			// Use the compiler-included build so Vue can compile templates from HTML
			'vue': 'vue/dist/vue.esm-bundler.js',
			'/hackrf-web/pkg': path.resolve(__dirname, 'hackrf-web/pkg'),
		},
	},
	server: {
		proxy: {
			'/api': 'http://localhost:8787',
			'/hf-proxy': 'http://localhost:8787',
		},
	},
});
