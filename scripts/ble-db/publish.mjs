import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { publishedManifest, snapshotChanged } from '../aircraft-db/publication.mjs';

const directory = resolve(process.argv[2] || 'public/ble-db');
const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
const bytes = await readFile(resolve(directory, 'macaddress.db'));
const digest = createHash('sha256').update(bytes).digest('hex');
if (
	manifest.schema !== 1 ||
	manifest.sha256 !== digest ||
	manifest.revision !== digest.slice(0, 24) ||
	manifest.bytes !== bytes.length ||
	!Number.isSafeInteger(manifest.count) ||
	manifest.count < 30000 ||
	manifest.count > 100000 ||
	bytes.length !== manifest.count * 71
)
	throw new Error('Invalid MAC database snapshot');
const bucket = process.env.DATABASES_BUCKET || 'browsdr-databases';
const base = (process.env.DATABASES_PUBLIC_URL || 'https://db.browser.jlynx.net/').replace(/\/?$/, '/');
const current = await publishedManifest(new URL('ble-db/', base).href);
if (!snapshotChanged(current, manifest)) {
	console.log(`Database unchanged (${manifest.revision}); no R2 objects updated.`);
	process.exit(0);
}
for (const name of ['macaddress.db', 'manifest.json']) {
	const result = spawnSync(
		process.execPath,
		[
			resolve('node_modules/wrangler/bin/wrangler.js'),
			'r2',
			'object',
			'put',
			`${bucket}/ble-db/${name}`,
			'--remote',
			'--file',
			resolve(directory, name),
			'--content-type',
			name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
			'--cache-control',
			'public, max-age=300',
		],
		{ stdio: 'inherit' },
	);
	if (result.status !== 0) throw new Error(`Upload failed: ${name}`);
}
