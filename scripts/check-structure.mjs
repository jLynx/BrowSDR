import fs from 'node:fs/promises';
import path from 'node:path';

// Feature folders should remain small enough to browse without scrolling through unrelated code.
const maximum = 14;
const failures = [];
async function check(directory) {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	const files = entries.filter((entry) => entry.isFile());
	if (files.length > maximum) failures.push(`${directory}: ${files.length} files (maximum ${maximum})`);
	await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => check(path.join(directory, entry.name))));
}
await Promise.all(['src', 'test', 'scripts'].map(check));
if (failures.length) {
	console.error('Group related files by feature:\n' + failures.join('\n'));
	process.exitCode = 1;
} else {
	console.log(`Source, test, and script folders contain at most ${maximum} files each.`);
}
