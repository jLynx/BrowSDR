import { isRecord } from '@/platform/data';
import { DATABASES_BASE } from '@/platform/databases';

export function maritimeMid(mmsi: string): string | undefined {
	if (!/^\d{9}$/.test(mmsi)) return;
	// Ship, group ship, coast, SAR aircraft, handheld, parent-associated craft and aids to navigation.
	const start = /^(00|98|99)/.test(mmsi) ? 2 : /^(0|8)/.test(mmsi) || mmsi.startsWith('111') ? (mmsi.startsWith('111') ? 3 : 1) : 0;
	const mid = mmsi.slice(start, start + 3);
	return /^[2-7]\d{2}$/.test(mid) ? mid : undefined;
}

function validMids(value: unknown): value is { schema: 1; mids: Record<string, string> } {
	return (
		isRecord(value) &&
		value.schema === 1 &&
		isRecord(value.mids) &&
		Object.keys(value.mids).length >= 280 &&
		Object.entries(value.mids).every(
			([mid, country]) => /^[2-7]\d{2}$/.test(mid) && typeof country === 'string' && country.length > 0 && country.length <= 512,
		)
	);
}

export async function loadMids(): Promise<Record<string, string> | undefined> {
	const remote = new URL(`${DATABASES_BASE}maritime-db/mids.json`, location.href).href;
	let cache: Cache | undefined;
	try {
		cache = await caches.open('browsdr-maritime-db-v1');
	} catch {
		/* Browser storage can be unavailable. */
	}
	for (const url of [remote, new URL('/maritime-db/mids.json', location.href).href]) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(8000), cache: 'no-cache' });
			if (!response.ok) continue;
			const value: unknown = await response.json();
			if (!validMids(value)) continue;
			await cache?.put(remote, new Response(JSON.stringify(value))).catch(() => {});
			return value.mids;
		} catch {
			/* Try the bundled table, then the previously saved table. */
		}
	}
	try {
		const value: unknown = await (await cache?.match(remote))?.json();
		return validMids(value) ? value.mids : undefined;
	} catch {
		return undefined;
	}
}
