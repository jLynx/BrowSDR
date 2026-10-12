import { afterEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { webcrypto } from 'node:crypto';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

async function fixture() {
	vi.stubGlobal('Blob', NodeBlob);
	vi.stubGlobal('crypto', webcrypto);
	const bytes = new Uint8Array(153);
	bytes.set(new TextEncoder().encode('C827EE\0ZK-NNF\0'));
	const hash = [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
	const revision = 'a'.repeat(24);
	const manifest = {
		schema: 1,
		revision,
		builtAt: '',
		files: {
			'aircraft-C8.db': { path: `${revision}/aircraft-C8.db`, count: 1, bytes: 153, sha256: hash },
			'airlines.db': { path: `${revision}/airlines.db`, count: 1, bytes: 68, sha256: 'b'.repeat(64) },
		},
	};
	const airlineBytes = new Uint8Array(68);
	airlineBytes.set(new TextEncoder().encode('ANZ\0Air New Zealand\0'));
	manifest.files['airlines.db'].sha256 = [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', airlineBytes))]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	const stored = new Map<string, Response>();
	const cache = {
		match: (key: string) => Promise.resolve(stored.get(key)?.clone()),
		put: (key: string, response: Response) => {
			stored.set(key, response.clone());
			return Promise.resolve();
		},
	};
	vi.stubGlobal('caches', { open: () => Promise.resolve(cache) });
	const fetch = vi.fn((url: string) =>
		Promise.resolve(
			new Response(url.endsWith('manifest.json') ? JSON.stringify(manifest) : url.endsWith('airlines.db') ? airlineBytes : bytes),
		),
	);
	vi.stubGlobal('fetch', fetch);
	return { fetch, stored, bytes, manifest, cache };
}

describe('BrowSDR hosted aircraft snapshots', () => {
	it('verifies downloads, looks up a fixed-width record, and reads it offline after reload', async () => {
		const { fetch } = await fixture();
		let snapshot = await import('@/app/decoders/adsb/database/snapshot');
		const format = { keySize: 7, fieldSizes: [9, 33, 33, 5, 33, 33] };
		expect(await snapshot.lookupSnapshot('C827EE', format)).toEqual(['ZK-NNF', '', '', '', '', '']);
		expect(fetch).toHaveBeenCalledTimes(2);
		vi.resetModules();
		fetch.mockRejectedValue(new Error('offline'));
		snapshot = await import('@/app/decoders/adsb/database/snapshot');
		expect(await snapshot.lookupSnapshot('C827EE', format, true)).toEqual(['ZK-NNF', '', '', '', '', '']);
		expect(fetch).toHaveBeenCalledTimes(3); // One manifest request; no aircraft request.
	});
	it('rejects checksum failures and keeps an offline-only lookup from downloading a shard', async () => {
		const { fetch, bytes } = await fixture();
		const snapshot = await import('@/app/decoders/adsb/database/snapshot');
		const data = await snapshot.snapshotManifest();
		expect(await snapshot.snapshotBlob(data!.files['aircraft-C8.db'], true)).toBeUndefined();
		expect(fetch).toHaveBeenCalledOnce();
		bytes[10] = 0;
		await expect(snapshot.snapshotBlob(data!.files['aircraft-C8.db'])).rejects.toThrow('checksum');
	});
	it('rejects an unsafe manifest path', async () => {
		const { manifest, fetch } = await fixture();
		manifest.files['aircraft-C8.db'].path = '../unrelated';
		fetch.mockResolvedValue(new Response(JSON.stringify(manifest)));
		const snapshot = await import('@/app/decoders/adsb/database/snapshot');
		expect(await snapshot.snapshotManifest()).toBeUndefined();
	});
	it('uses the complete saved snapshot offline after a newer online manifest was seen', async () => {
		const { fetch, manifest } = await fixture();
		let snapshot = await import('@/app/decoders/adsb/database/snapshot');
		expect(await snapshot.saveSnapshot(() => {})).toBe(true);
		expect(await snapshot.snapshotOfflineAvailable()).toBe(true);
		vi.resetModules();
		const newer = {
			...manifest,
			revision: 'c'.repeat(24),
			files: Object.fromEntries(
				Object.entries(manifest.files).map(([name, file]) => [name, { ...file, path: `${'c'.repeat(24)}/${name}` }]),
			),
		};
		fetch.mockResolvedValue(new Response(JSON.stringify(newer)));
		snapshot = await import('@/app/decoders/adsb/database/snapshot');
		expect((await snapshot.snapshotManifest())?.revision).toBe(newer.revision);
		vi.resetModules();
		fetch.mockRejectedValue(new Error('offline'));
		const database = await import('@/app/decoders/adsb/database/lookup');
		expect((await database.lookupOfflineAircraft('C827EE'))?.registration).toBe('ZK-NNF');
		expect((await database.lookupOfflineAirline('ANZ123'))?.airline).toBe('Air New Zealand');
	});
	it('surfaces an unavailable database and retries the manifest after connectivity returns', async () => {
		const { fetch, manifest } = await fixture();
		fetch.mockRejectedValueOnce(new Error('offline'));
		const database = await import('@/app/decoders/adsb/database/lookup');
		await expect(database.lookupAircraft('C827EE')).rejects.toThrow('unavailable');
		expect((await database.lookupAircraft('C827EE'))?.registration).toBe('ZK-NNF');
		expect(fetch.mock.calls.every(([url]) => url.startsWith('https://db.browser.jlynx.net/'))).toBe(true);
		expect(manifest.revision).toBe('a'.repeat(24));
	});
	it('does not mark a snapshot saved when storage quota is exhausted', async () => {
		const { cache, stored } = await fixture();
		const snapshot = await import('@/app/decoders/adsb/database/snapshot');
		await snapshot.snapshotManifest();
		vi.spyOn(cache, 'put').mockRejectedValue(new Error('quota'));
		await expect(snapshot.saveSnapshot(() => {})).rejects.toThrow('quota');
		expect([...stored.keys()].some((key) => key.endsWith('offline-manifest.json'))).toBe(false);
	});
	it('detects a newer published revision, keeps the saved copy on failure, and clears the update after saving', async () => {
		const { fetch, manifest, bytes } = await fixture();
		const snapshot = await import('@/app/decoders/adsb/database/snapshot');
		expect(await snapshot.offlineSnapshotState()).toBe('missing');
		await snapshot.saveSnapshot(() => {});
		expect(await snapshot.offlineSnapshotState()).toBe('current');
		const newer = {
			...manifest,
			revision: 'c'.repeat(24),
			files: Object.fromEntries(
				Object.entries(manifest.files).map(([name, file]) => [name, { ...file, path: `${'c'.repeat(24)}/${name}` }]),
			),
		};
		fetch.mockResolvedValueOnce(new Response(JSON.stringify(newer)));
		expect(await snapshot.offlineSnapshotState(true)).toBe('update');
		fetch.mockRejectedValueOnce(new Error('offline'));
		expect(await snapshot.offlineSnapshotState(true)).toBe('current');
		fetch.mockResolvedValueOnce(new Response(JSON.stringify(newer)));
		expect(await snapshot.offlineSnapshotState(true)).toBe('update');
		fetch.mockResolvedValueOnce(new Response(bytes));
		// The airline file retains its original valid bytes via the fixture's default handler.
		await snapshot.saveSnapshot(() => {});
		expect(await snapshot.offlineSnapshotState()).toBe('current');
	});
});
