import path from 'node:path';
import { sourceAlias } from '../../source-alias.mjs';

/** Keep parent-directory module imports inside the client source rooted at @/. */
export const sourceAliasRule = {
	meta: {
		type: 'suggestion',
		docs: { description: 'Use @/ for parent-directory imports into client source.' },
		fixable: 'code',
		schema: [],
		messages: { useAlias: 'Use "{{alias}}" instead of the parent-directory import "{{original}}".' },
	},
	create(context) {
		function check(source) {
			if (typeof source?.value !== 'string' || !source.value.startsWith('../')) return;
			const target = path.resolve(path.dirname(context.filename), source.value);
			const relative = path.relative(sourceAlias['@'], target);
			if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
			const alias = `@/${relative.split(path.sep).join('/')}`;
			context.report({
				node: source,
				messageId: 'useAlias',
				data: { alias, original: source.value },
				fix(fixer) {
					const quote = context.sourceCode.getText(source)[0];
					const escaped = alias.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`);
					return fixer.replaceText(source, `${quote}${escaped}${quote}`);
				},
			});
		}
		return {
			ImportDeclaration: (node) => check(node.source),
			ExportNamedDeclaration: (node) => check(node.source),
			ExportAllDeclaration: (node) => check(node.source),
			ImportExpression: (node) => check(node.source),
			CallExpression(node) {
				const callee = node.callee;
				if (
					callee.type === 'MemberExpression' &&
					!callee.computed &&
					callee.object.type === 'Identifier' &&
					callee.object.name === 'vi' &&
					['mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock'].includes(callee.property.name)
				)
					check(node.arguments[0]);
			},
		};
	},
};

export default { rules: { 'source-alias': sourceAliasRule } };
