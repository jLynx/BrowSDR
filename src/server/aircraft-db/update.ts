import { buildDatabase } from './build';
import { resolveAircraftUrl } from './discovery';
import { contentRevision } from './format';
import { airlinesUrl, sameSources, sourceDigest } from './sources';
import type { DatabaseManifest } from './types';

const manifestKey = 'aircraft-db/manifest.json';

async function currentManifest(bucket: R2Bucket) {
	const object = await bucket.get(manifestKey);
	if (!object) return undefined;
	const value = await object.json<DatabaseManifest>();
	if (value.schema !== 1 || !/^[a-f0-9]{24}$/.test(value.revision) || !Array.isArray(value.sources))
		throw new Error('Invalid published manifest; refusing to replace it');
	return { value, etag: object.etag };
}

async function clearStaging(bucket: R2Bucket, prefix: string) {
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor });
		if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

export async function updateDatabase(bucket: R2Bucket) {
	const current = await currentManifest(bucket);
	const aircraftUrl = await resolveAircraftUrl();
	// Hash complete source bodies: timestamps and HTTP validators alone do not establish a change.
	const sources = [await sourceDigest(aircraftUrl), await sourceDigest(airlinesUrl)];
	if (current && sameSources(current.value.sources, sources)) {
		console.log(`Sources unchanged (${current.value.revision}); no R2 objects updated.`);
		return { changed: false, revision: current.value.revision };
	}
	const root = `aircraft-db-staging/${crypto.randomUUID()}`;
	try {
		const built = await buildDatabase(bucket, root, aircraftUrl);
		if (!sameSources(sources, built.sources)) throw new Error('Upstream changed during build; retry on next run');
		const revision = contentRevision(built.files);
		if (current?.value.revision === revision) {
			console.log(`Database content unchanged (${revision}); published objects preserved.`);
			return { changed: false, revision };
		}
		const files = Object.fromEntries(
			Object.entries(built.files)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, file]) => [name, { ...file, path: `${revision}/${name}` }]),
		);
		for (const [name, file] of Object.entries(files)) {
			const staged = await bucket.get(built.files[name].path);
			if (!staged) throw new Error(`Missing staged database: ${name}`);
			await bucket.put(`aircraft-db/${file.path}`, staged.body, {
				sha256: file.sha256,
				httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'public, max-age=31536000, immutable' },
			});
		}
		const manifest: DatabaseManifest = { schema: 1, revision, builtAt: new Date().toISOString(), sources: built.sources, files };
		const published = await bucket.put(manifestKey, JSON.stringify(manifest, null, 2) + '\n', {
			onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' },
			httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=300' },
		});
		if (!published) throw new Error('Another publisher changed the manifest during this build');
		console.log(`Published aircraft database ${revision} (${Object.keys(files).length} files).`);
		return { changed: true, revision };
	} finally {
		await clearStaging(bucket, root + '/');
	}
}
