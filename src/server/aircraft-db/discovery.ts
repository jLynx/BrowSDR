import { download } from './sources';

const metadataBucket = 'https://s3.opensky-network.org/data-samples/';
export const metadataListUrl = `${metadataBucket}?list-type=2&prefix=metadata%2F`;
const snapshotKey = /^metadata\/aircraft-database-complete-(\d{4})-(0[1-9]|1[0-2])\.csv$/;

function xmlText(xml: string, name: string) {
	const value = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
	return value?.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, entity: string) => {
		const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
		if (entity.startsWith('#')) {
			const number = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
			if (!Number.isInteger(number) || number < 0 || number > 0x10ffff) throw new Error('Invalid listing XML entity');
			return String.fromCodePoint(number);
		}
		return named[entity];
	});
}

/** Use release months, since archive migrations can change LastModified on old files. */
export async function resolveAircraftUrl() {
	let latest = '';
	let latestSize = 0;
	let token: string | undefined;
	const seen = new Set<string>();
	for (let page = 0; page < 10; page++) {
		const url = new URL(metadataListUrl);
		if (token) url.searchParams.set('continuation-token', token);
		const response = await download(url.href);
		const text = await response.text();
		if (text.length > 1024 * 1024 || !/<ListBucketResult(?:\s[^>]*)?>/.test(text)) throw new Error('Invalid OpenSky metadata listing');
		for (const contents of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
			const key = xmlText(contents[1], 'Key') || '';
			const size = Number(xmlText(contents[1], 'Size'));
			if (snapshotKey.test(key) && size > 0 && key > latest) {
				latest = key;
				latestSize = size;
			}
		}
		const truncated = xmlText(text, 'IsTruncated');
		if (truncated === 'false') {
			if (!latest) throw new Error('No complete OpenSky aircraft snapshot found');
			if (latestSize > 256 * 1024 * 1024) throw new Error('Latest OpenSky snapshot exceeds source size limit');
			return new URL(latest, metadataBucket).href;
		}
		token = xmlText(text, 'NextContinuationToken');
		if (truncated !== 'true' || !token || seen.has(token)) throw new Error('Invalid OpenSky listing pagination');
		seen.add(token);
	}
	throw new Error('OpenSky metadata listing exceeds page limit');
}
