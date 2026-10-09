import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { publishedManifest, snapshotChanged } from './publication.mjs';

const directory = resolve(process.argv[2] || 'public/aircraft-db');
const bucket = process.env.DATABASES_BUCKET || process.env.AIRCRAFT_DB_BUCKET || 'browsdr-aircraft-db';
const prefix = 'aircraft-db/';
const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
if (!/^[a-f0-9]{24}$/.test(manifest.revision)) throw new Error('Invalid database revision');
const publicBase =
	process.env.AIRCRAFT_DB_PUBLIC_URL ||
	(process.env.DATABASES_PUBLIC_URL ? new URL('aircraft-db/', process.env.DATABASES_PUBLIC_URL).href : undefined) ||
	'https://aircraft-db.browsdr.jlynx.net/aircraft-db/';
const current = await publishedManifest(publicBase);
if (!snapshotChanged(current, manifest)) {
	console.log(`Database unchanged (${manifest.revision}); no R2 objects updated.`);
	process.exit(0);
}

function upload(key, file, contentType, cacheControl) {
	const result = spawnSync(
		process.execPath,
		[
			resolve('node_modules/wrangler/bin/wrangler.js'),
			'r2',
			'object',
			'put',
			`${bucket}/${prefix}${key}`,
			'--remote',
			'--file',
			file,
			'--content-type',
			contentType,
			'--cache-control',
			cacheControl,
		],
		{ stdio: 'inherit' },
	);
	if (result.status !== 0) throw new Error(`Upload failed: ${key}`);
}

for (const [name, file] of Object.entries(manifest.files)) {
	if (!/^(aircraft-[A-F0-9]{2}|airlines)\.db$/.test(name) || file.path !== `${manifest.revision}/${name}`)
		throw new Error('Invalid snapshot path');
	upload(file.path, resolve(directory, file.path), 'application/octet-stream', 'public, max-age=31536000, immutable');
}
// A failed upload leaves the previously published snapshot selected.
upload('manifest.json', resolve(directory, 'manifest.json'), 'application/json', 'public, max-age=300');
