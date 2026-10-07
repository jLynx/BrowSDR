import { defineConfig } from 'vitest/config';
import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'client',
					include: ['test/**/*.spec.js'],
					exclude: ['test/index.spec.js'],
				},
			},
			defineWorkersProject({
				test: {
					name: 'worker',
					include: ['test/index.spec.js'],
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
