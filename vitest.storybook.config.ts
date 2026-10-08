/// <reference types="@vitest/browser/providers/playwright" />
import { defineConfig } from 'vitest/config';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';

export default defineConfig({
	define: { __VUE_OPTIONS_API__: true, __VUE_PROD_DEVTOOLS__: false, __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false },
	plugins: [storybookTest({ configDir: '.storybook' })],
	test: {
		name: process.env.STORYBOOK_CONFIG_DIR ? `storybook:${process.env.STORYBOOK_CONFIG_DIR}` : 'storybook',
		browser: {
			enabled: true,
			headless: true,
			provider: 'playwright',
			api: { host: '127.0.0.1', port: 6010 },
			instances: [{ browser: 'chromium', launch: { channel: process.env.PLAYWRIGHT_CHANNEL } }],
		},
	},
});
