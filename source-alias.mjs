import { fileURLToPath } from 'node:url';

// Shared by the app, nested workers, Storybook, tests, and offline validators.
export const sourceAlias = {
	'@': fileURLToPath(new URL('./src/client', import.meta.url)),
	'/wasm/dsp': fileURLToPath(new URL('./wasm/dsp/pkg', import.meta.url)),
};
