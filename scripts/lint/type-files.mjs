import path from 'node:path';

/** Keep named type contracts next to their feature in a discoverable types file. */
export const typeFilesRule = {
	meta: {
		type: 'suggestion',
		docs: { description: 'Declare interfaces and type aliases in feature types files.' },
		schema: [],
		messages: { useTypesFile: 'Move "{{name}}" to this feature\'s types.ts or a descriptive *.types.ts file.' },
	},
	create(context) {
		const filename = path.basename(context.filename);
		if (filename === 'types.ts' || filename.endsWith('.types.ts') || filename.endsWith('.d.ts')) return {};
		function check(node) {
			// Storybook's Story alias is derived from the metadata in the same story.
			if (
				filename.endsWith('.stories.ts') &&
				node.type === 'TSTypeAliasDeclaration' &&
				node.id.name === 'Story' &&
				node.typeAnnotation.type === 'TSTypeReference' &&
				node.typeAnnotation.typeName.type === 'Identifier' &&
				node.typeAnnotation.typeName.name === 'StoryObj'
			)
				return;
			context.report({ node: node.id, messageId: 'useTypesFile', data: { name: node.id.name } });
		}
		return { TSInterfaceDeclaration: check, TSTypeAliasDeclaration: check };
	},
};

export default { rules: { 'type-files': typeFilesRule } };
