import { sourceAlias } from '../source-alias.mjs';
import { defineConfig } from 'vite';

export default defineConfig({
	resolve: { alias: { ...sourceAlias, vue: 'vue/dist/vue.esm-bundler.js' } },
	define: { __VUE_OPTIONS_API__: true, __VUE_PROD_DEVTOOLS__: false, __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false },
});
