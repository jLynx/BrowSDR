import type { StorybookConfig } from '@storybook/vue3-vite';

const config: StorybookConfig = {
	stories: ['../src/client/ui/**/*.stories.ts'],
	addons: ['@storybook/addon-docs', '@storybook/addon-vitest'],
	framework: { name: '@storybook/vue3-vite', options: {} },
	// Do not inherit the app's PWA, WASM copying, or nested-worker build plugins.
	core: { disableTelemetry: true, builder: { name: '@storybook/builder-vite', options: { viteConfigPath: '.storybook/vite.config.ts' } } },
	features: { experimentalDocgenServer: true },
};
export default config;
