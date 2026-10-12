import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { typeFilesRule } from '../../scripts/lint/type-files.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
tester.run('type-files', typeFilesRule, {
	valid: [
		{ filename: '/src/radio/types.ts', code: 'export interface Radio { frequency: number }' },
		{ filename: '/src/app/receiver.types.ts', code: 'export type Receiver = { id: string };' },
		{ filename: '/src/platform/env.d.ts', code: 'interface Navigator { usb: unknown }' },
		{ filename: '/src/radio/receiver.ts', code: "import type { Radio } from './types';" },
		{ filename: '/src/ui/Button.stories.ts', code: 'type Story = StoryObj<typeof meta>;' },
	],
	invalid: [
		{ filename: '/src/radio/receiver.ts', code: 'export interface Radio { frequency: number }', errors: [{ messageId: 'useTypesFile' }] },
		{ filename: '/src/radio/receiver.ts', code: 'type Params = { frequency: number };', errors: [{ messageId: 'useTypesFile' }] },
		{ filename: '/src/radio/receiver.ts', code: 'function load() { type Result = string; }', errors: [{ messageId: 'useTypesFile' }] },
		{ filename: '/src/ui/Button.stories.ts', code: 'interface Props { label: string }', errors: [{ messageId: 'useTypesFile' }] },
		{ filename: '/src/ui/Button.stories.ts', code: 'type Story = { args: unknown };', errors: [{ messageId: 'useTypesFile' }] },
	],
});
