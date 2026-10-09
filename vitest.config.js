import { sourceAlias } from './source-alias.mjs';
import { defineConfig } from 'vitest/config';
import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

// @storybook/addon-vitest discovers this config for its in-app testing panel.
// Ordinary application tests stay independent of an installed browser.
const storybookProjects = process.env.STORYBOOK_CONFIG_DIR ? ['./vitest.storybook.config.ts'] : [];

export default defineConfig({
	test: {
		projects: [
			...storybookProjects,
			'./vitest.ui.config.ts',
			{
				resolve: { alias: sourceAlias },
				test: {
					name: 'client',
					include: ['test/**/*.spec.js'],
					exclude: ['test/server/**'],
				},
			},
			defineWorkersProject({
				test: {
					name: 'worker',
					include: ['test/server/**/*.spec.js'],
					poolOptions: {
						workers: {
							wrangler: { configPath: './wrangler.jsonc' },
						},
					},
				},
			}),
		],
	},
});
