import { MID_KEY, MID_SOURCE, MID_TABLE, midRevision, parseMids } from './mids';
import type { MidDatabase } from './types';

export async function updateMaritimeDatabase(bucket: R2Bucket): Promise<{ changed: boolean; revision: string }> {
	const current = await bucket.get(MID_KEY);
	const previous = current ? await current.json<MidDatabase>() : undefined;
	if (previous && (previous.schema !== 1 || !/^[a-f0-9]{24}$/.test(previous.revision))) throw new Error('Invalid published MID database');
	const response = await fetch(MID_TABLE, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'BrowSDR-Database' } });
	if (!response.ok || !response.body) throw new Error(`ITU MID download failed: HTTP ${response.status}`);
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let html = '';
	let bytes = 0;
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		bytes += chunk.value.length;
		if (bytes > 2 * 1024 * 1024) {
			await reader.cancel();
			throw new Error('ITU MID table exceeds size limit');
		}
		html += decoder.decode(chunk.value, { stream: true });
	}
	html += decoder.decode();
	const mids = parseMids(html);
	const revision = midRevision(mids);
	if (previous?.revision === revision) return { changed: false, revision };
	const database: MidDatabase = { schema: 1, revision, source: MID_SOURCE, fetchedAt: new Date().toISOString(), mids };
	const published = await bucket.put(MID_KEY, JSON.stringify(database) + '\n', {
		onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' },
		httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=300' },
	});
	if (!published) throw new Error('Another publisher changed the MID database');
	return { changed: true, revision };
}
