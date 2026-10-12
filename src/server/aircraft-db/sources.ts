import { createHash } from 'node:crypto';
import type { SourceDigest } from './types';

export const airlinesUrl = 'https://raw.githubusercontent.com/kx1t/planefence-airlinecodes/main/airlinecodes.txt';

export async function download(url: string) {
	const response = await fetch(url, {
		headers: { 'User-Agent': 'BrowSDR-Aircraft-Database', 'Cache-Control': 'no-cache' },
		signal: AbortSignal.timeout(180000),
	});
	if (!response.ok || !response.body) throw new Error(`Source download failed: ${url}, HTTP ${response.status}`);
	return response;
}

export async function sourceDigest(url: string): Promise<SourceDigest> {
	const response = await download(url);
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	const hash = createHash('sha256');
	let bytes = 0;
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		bytes += chunk.value.length;
		if (bytes > 256 * 1024 * 1024) {
			await reader.cancel();
			throw new Error('Source exceeds streaming size limit');
		}
		hash.update(chunk.value);
	}
	if (!bytes) throw new Error('Empty database source');
	return { url, sha256: hash.digest('hex') };
}

export function sameSources(previous: SourceDigest[], next: SourceDigest[]) {
	return next.every((source) => previous.some((old) => old.url === source.url && old.sha256 === source.sha256));
}
