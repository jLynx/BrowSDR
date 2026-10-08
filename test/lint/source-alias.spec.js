import path from 'node:path';
import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import { sourceAlias } from '../../source-alias.mjs';
import { sourceAliasRule } from '../../scripts/lint/source-alias.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const filename = path.join(sourceAlias['@'], 'app/radio/example.ts');
const tester = new RuleTester({ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } });

tester.run('source-alias', sourceAliasRule, {
	valid: [
		{ filename, code: "import { value } from './nearby';" },
		{ filename, code: "import { value } from '@/app/core/types';" },
		{ filename, code: "new Worker(new URL('../../worker/dsp-worker.ts', import.meta.url));" },
		{ filename, code: "import value from '../../../../source-alias.mjs';" },
		{ filename, code: "fetch('../../asset.json');" },
	],
	invalid: [
		{
			filename,
			code: "import { value } from '../core/types';",
			output: "import { value } from '@/app/core/types';",
			errors: [{ messageId: 'useAlias' }],
		},
		{
			filename,
			code: 'export * from "../../platform/data";',
			output: 'export * from "@/platform/data";',
			errors: [{ messageId: 'useAlias' }],
		},
		{
			filename,
			code: "import('../../app/templates/shell.html?raw');",
			output: "import('@/app/templates/shell.html?raw');",
			errors: [{ messageId: 'useAlias' }],
		},
		{
			filename,
			code: "vi.mock('../../remote/webrtc', () => ({}));",
			output: "vi.mock('@/remote/webrtc', () => ({}));",
			errors: [{ messageId: 'useAlias' }],
		},
		{
			filename: path.join(sourceAlias['@'], '../../test/remote/example.spec.js'),
			code: "import { value } from '../../src/client/platform/data';",
			output: "import { value } from '@/platform/data';",
			errors: [{ messageId: 'useAlias' }],
		},
	],
});
