import { isRecord } from '@/platform/data';
import { DATABASES_BASE } from '@/platform/databases';
import { parseMacVendors } from './vendor-records';
import type { MacVendorDatabase, MacVendorManifest } from './types';

const namespace = 'ble-db/';
let pending: Promise<MacVendorDatabase | undefined> | undefined;

function validManifest(value: unknown): value is MacVendorManifest {
	return (
		isRecord(value) &&
		value.schema === 1 &&
		typeof value.sha256 === 'string' &&
		/^[a-f0-9]{64}$/.test(value.sha256) &&
		value.revision === value.sha256.slice(0, 24) &&
		typeof value.count === 'number' &&
		Number.isSafeInteger(value.count) &&
		value.count >= 30000 &&
		value.count <= 100000 &&
		value.bytes === value.count * 71
	);
}

async function verifiedDatabase(manifestResponse: Response | undefined, response: Response | undefined): Promise<MacVendorDatabase> {
	if (!manifestResponse?.ok || !response?.ok) throw new Error('MAC database unavailable');
	const manifest: unknown = await manifestResponse.json();
	if (!validManifest(manifest)) throw new Error('Invalid MAC database manifest');
	const buffer = await response.arrayBuffer();
	if (buffer.byteLength !== manifest.bytes) throw new Error('Incomplete MAC database');
	const digest = await crypto.subtle.digest('SHA-256', buffer);
	const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	if (hash !== manifest.sha256) throw new Error('MAC database checksum mismatch');
	return parseMacVendors(new Uint8Array(buffer));
}

async function loadDatabase(): Promise<MacVendorDatabase | undefined> {
	const remote = new URL(`${DATABASES_BASE}${namespace}`, location.href).href;
	const bundled = new URL(`/${namespace}`, location.href).href;
	let cache: Cache | undefined;
	try {
		cache = await caches.open('browsdr-ble-vendors-v1');
	} catch {
		/* Browser storage is optional for online and bundled lookups. */
	}
	for (const base of new Set([remote, bundled])) {
		try {
			const manifest = await fetch(`${base}manifest.json`, { signal: AbortSignal.timeout(8000), cache: 'no-cache' });
			if (!manifest.ok) continue;
			const response = await fetch(`${base}macaddress.db`, { signal: AbortSignal.timeout(15000), cache: 'no-cache' });
			const value = await verifiedDatabase(manifest.clone(), response.clone());
			// Store the verified pair together so an interrupted write cannot replace the previous snapshot.
			const saved = new Blob([JSON.stringify(await manifest.json()), '\n', value.bytes.buffer as ArrayBuffer]);
			await cache?.put(remote, new Response(saved)).catch(() => {});
			return value;
		} catch {
			/* Try the bundled snapshot, then the last verified cached snapshot. */
		}
	}
	try {
		const saved = await cache?.match(remote);
		if (!saved) return;
		const bytes = new Uint8Array(await saved.arrayBuffer());
		const end = bytes.subarray(0, 1024).indexOf(10);
		if (end < 0) return;
		return await verifiedDatabase(new Response(bytes.slice(0, end)), new Response(bytes.slice(end + 1)));
	} catch {
		return undefined;
	}
}

export function loadMacVendors(): Promise<MacVendorDatabase | undefined> {
	return (pending ??= loadDatabase().then((value) => {
		if (!value) pending = undefined;
		return value;
	}));
}
