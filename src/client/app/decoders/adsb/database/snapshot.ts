import { DATABASES_BASE } from '@/platform/databases';
import type { SnapshotManifest, SnapshotFile, OfflineSnapshotState, DatabaseFormat } from './types';

export const SNAPSHOT_BASE = `${DATABASES_BASE}aircraft-db/`;
const CACHE = 'browsdr-aircraft-snapshots-v1';
let manifest: Promise<SnapshotManifest | undefined> | undefined;
let refresh: Promise<SnapshotManifest | undefined> | undefined;
const blobs = new Map<string, Blob>();
const pending = new Map<string, Promise<Blob>>();

function validManifest(value: unknown): value is SnapshotManifest {
	if (!value || typeof value !== 'object') return false;
	const data = value as SnapshotManifest;
	if (data.schema !== 1 || !/^[a-f0-9]{24}$/.test(data.revision) || !data.files || typeof data.files !== 'object') return false;
	const entries = Object.entries(data.files);
	return (
		entries.length > 0 &&
		entries.length <= 257 &&
		!!data.files['airlines.db'] &&
		entries.every(([name, file]) => {
			const width = name === 'airlines.db' ? 68 : /^aircraft-[A-F0-9]{2}\.db$/.test(name) ? 153 : 0;
			return (
				file &&
				file.path === `${data.revision}/${name}` &&
				Number.isSafeInteger(file.count) &&
				file.count > 0 &&
				file.bytes === file.count * width &&
				file.bytes <= 25 * 1024 * 1024 &&
				/^[a-f0-9]{64}$/.test(file.sha256)
			);
		})
	);
}

function url(path: string): string {
	return new URL(SNAPSHOT_BASE + path, location.href).href;
}
export async function snapshotCache(): Promise<Cache | undefined> {
	try {
		return await caches.open(CACHE);
	} catch {
		return undefined;
	}
}

async function loadManifest(): Promise<SnapshotManifest | undefined> {
	const cache = await snapshotCache();
	const key = url('manifest.json');
	try {
		const response = await fetch(key, { signal: AbortSignal.timeout(8000), cache: 'no-cache' });
		if (!response.ok) throw new Error('No hosted database');
		const value: unknown = await response.json();
		if (!validManifest(value)) throw new Error('Invalid snapshot manifest');
		await cache?.put(key, new Response(JSON.stringify(value))).catch(() => {});
		return value;
	} catch {
		try {
			const saved = await cache?.match(url('offline-manifest.json'));
			const value: unknown = await (saved ?? (await cache?.match(key)))?.json();
			return validManifest(value) ? value : undefined;
		} catch {
			return undefined;
		}
	}
}

export function snapshotManifest(recheck = false): Promise<SnapshotManifest | undefined> {
	if (recheck) {
		if (!refresh) {
			refresh = loadManifest()
				.then((value) => {
					manifest = value ? Promise.resolve(value) : undefined;
					return value;
				})
				.finally(() => {
					refresh = undefined;
				});
		}
		return refresh;
	}
	return (manifest ??= loadManifest().then((value) => {
		if (!value) manifest = undefined;
		return value;
	}));
}

async function verifiedBlob(response: Response, file: SnapshotFile): Promise<Blob> {
	if (!response.ok) throw new Error('Snapshot download failed');
	const blob = await response.blob();
	if (blob.size !== file.bytes) throw new Error('Incomplete snapshot download');
	const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
	const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	if (hash !== file.sha256) throw new Error('Snapshot checksum mismatch');
	return blob;
}

export async function snapshotBlob(file: SnapshotFile, offlineOnly = false): Promise<Blob | undefined> {
	const key = url(file.path);
	if (blobs.has(key)) return blobs.get(key);
	const cache = await snapshotCache();
	const cached = await cache?.match(key);
	let blob = cached ? await cached.blob() : undefined;
	if (blob?.size !== file.bytes) blob = undefined;
	if (!blob && offlineOnly) return undefined;
	if (!blob) {
		if (!pending.has(key)) {
			if (pending.size >= 8) throw new Error('Database busy');
			const task = fetch(key, { signal: AbortSignal.timeout(180000) }).then((response) => verifiedBlob(response, file));
			pending.set(key, task);
			void task.finally(() => pending.delete(key)).catch(() => {});
		}
		blob = await pending.get(key)!;
		await cache?.put(key, new Response(blob)).catch(() => {});
	}
	blobs.set(key, blob);
	if (blobs.size > 8) blobs.delete(blobs.keys().next().value!);
	return blob;
}

export async function lookupSnapshot(key: string, format: DatabaseFormat, offlineOnly = false): Promise<string[] | undefined> {
	const data = await snapshotManifest();
	if (!data && !offlineOnly) throw new Error('Aircraft database unavailable');
	const file = data?.files[format.keySize === 7 ? `aircraft-${key.slice(0, 2)}.db` : 'airlines.db'];
	if (!file) return undefined;
	const blob = await snapshotBlob(file, offlineOnly);
	if (!blob) return undefined;
	let low = 0,
		high = file.count - 1;
	const decoder = new TextDecoder();
	while (low <= high) {
		const index = Math.floor((low + high) / 2);
		const bytes = new Uint8Array(await blob.slice(index * format.keySize, (index + 1) * format.keySize).arrayBuffer());
		const candidate = decoder.decode(bytes).replace(/\0.*$/, '');
		if (candidate === key) {
			const width = format.fieldSizes.reduce((sum, size) => sum + size, 0);
			const start = file.count * format.keySize + index * width;
			const values = new Uint8Array(await blob.slice(start, start + width).arrayBuffer());
			let offset = 0;
			return format.fieldSizes.map((size) => {
				const value = decoder
					.decode(values.subarray(offset, offset + size))
					.replace(/\0.*$/, '')
					.trim();
				offset += size;
				return value;
			});
		}
		if (candidate < key) low = index + 1;
		else high = index - 1;
	}
	return undefined;
}

async function hasSnapshotFiles(data: SnapshotManifest, cache: Cache | undefined): Promise<boolean> {
	// Check presence without loading hundreds of database Blobs into memory.
	for (const file of Object.values(data.files)) if (!(await cache?.match(url(file.path)))) return false;
	return true;
}

export async function snapshotOfflineAvailable(): Promise<boolean> {
	const data = await snapshotManifest();
	return !!data && hasSnapshotFiles(data, await snapshotCache());
}

export async function offlineSnapshotState(recheck = false): Promise<OfflineSnapshotState> {
	const data = await snapshotManifest(recheck);
	const cache = await snapshotCache();
	if (data && (await hasSnapshotFiles(data, cache))) return 'current';
	try {
		const saved: unknown = await (await cache?.match(url('offline-manifest.json')))?.json();
		if (validManifest(saved) && (await hasSnapshotFiles(saved, cache))) {
			return data && data.revision !== saved.revision ? 'update' : 'current';
		}
	} catch {
		/* A missing or evicted saved snapshot can be downloaded again. */
	}
	return 'missing';
}

export async function saveSnapshot(onStatus: (status: string) => void): Promise<boolean> {
	const data = await snapshotManifest();
	if (!data) return false;
	const cache = await snapshotCache();
	if (!cache) throw new Error('Browser storage unavailable');
	const files = Object.values(data.files);
	for (let i = 0; i < files.length; i++) {
		onStatus(`Saving aircraft database ${i + 1}/${files.length}…`);
		const blob = await snapshotBlob(files[i]);
		if (!blob) throw new Error('Missing snapshot file');
		// Explicit saves must report quota errors rather than treating them as an online-only lookup.
		await cache.put(url(files[i].path), new Response(blob));
	}
	await cache.put(url('offline-manifest.json'), new Response(JSON.stringify(data)));
	return true;
}
