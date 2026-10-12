import { sourceAlias } from './source-alias.mjs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: { alias: { ...sourceAlias, vue: 'vue/dist/vue.esm-bundler.js' } },
	test: { name: 'ui', environment: 'jsdom', include: ['test/ui/**/*.spec.ts'] },
});
