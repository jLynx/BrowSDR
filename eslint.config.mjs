import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import prettier from 'eslint-config-prettier/flat';
import imports from './scripts/lint/source-alias.mjs';

export default defineConfig(
	globalIgnores([
		'**/dist/**',
		'storybook-static/**',
		'coverage/**',
		'.wrangler/**',
		'.cache/**',
		'.codex/**',
		'public/lib/**',
		'hackrf-web/pkg/**',
		'hackrf-web/node/**',
		'**/target/**',
		'rtl433-wasm/**',
		'mbelib-wasm/**',
	]),
	{
		files: ['**/*.{js,mjs,ts}'],
		extends: [js.configs.recommended],
		linterOptions: { reportUnusedDisableDirectives: 'error' },
		rules: {
			'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			'prefer-const': 'error',
			'no-var': 'error',
			eqeqeq: ['error', 'always', { null: 'ignore' }],
		},
	},
	{
		files: ['*.{js,mjs,ts}', 'scripts/**/*.mjs', '.storybook/*.ts', 'test/**/*.{js,ts}', 'hackrf-web/*.mjs'],
		languageOptions: { globals: globals.node },
	},
	{
		files: ['src/**/*.ts', 'test/**/*.{ts,js}'],
		languageOptions: { globals: { ...globals.browser, ...globals.worker } },
	},
	{
		files: ['src/**/*.ts', '.storybook/*.ts', '*config.ts'],
		extends: [tseslint.configs.recommendedTypeChecked, vue.configs['flat/essential']],
		languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			'@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
			'@typescript-eslint/no-import-type-side-effects': 'error',
			'@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
			'@typescript-eslint/ban-ts-comment': [
				'error',
				{ 'ts-ignore': true, 'ts-expect-error': 'allow-with-description', minimumDescriptionLength: 10 },
			],
			'max-lines': ['error', { max: 600, skipBlankLines: true, skipComments: true }],
			'max-lines-per-function': ['error', { max: 100, skipBlankLines: true, skipComments: true }],
			complexity: ['error', 20],
		},
	},
	{
		files: ['src/client/**/*.ts', 'test/**/*.{js,ts}', '.storybook/*.ts'],
		plugins: { imports },
		rules: { 'imports/source-alias': 'error' },
	},
	{
		files: ['test/**/*.ts'],
		extends: [tseslint.configs.recommended],
		rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }] },
	},
	prettier,
);
