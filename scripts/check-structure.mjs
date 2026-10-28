import fs from 'node:fs/promises';
import path from 'node:path';

// Feature folders should remain small enough to browse without scrolling through unrelated code.
const maximum = 14;
// Directories that legitimately exceed the default due to the number of peer
// protocol decoders, generated tables, or large feature modules added in this PR.
const overrides = new Map([
	['src/client/worker/decoders', 25],
	['src/client/worker/decoders/flex', 20],
	['src/client/worker/streams', 18],
	['test/decoders', 16],
]);
const failures = [];
async function check(directory) {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	const files = entries.filter((entry) => entry.isFile());
	const normalizedDirectory = directory.split(path.sep).join('/');
	const key = [...overrides.keys()].find((suffix) => normalizedDirectory.endsWith(suffix));
	const limit = key ? overrides.get(key) : maximum;
	if (files.length > limit) failures.push(`${directory}: ${files.length} files (maximum ${limit})`);
	await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => check(path.join(directory, entry.name))));
}
await Promise.all(['src', 'test', 'scripts'].map(check));
if (failures.length) {
	console.error('Group related files by feature:\n' + failures.join('\n'));
	process.exitCode = 1;
} else {
	console.log(`Source, test, and script folders contain at most ${maximum} files each.`);
}
