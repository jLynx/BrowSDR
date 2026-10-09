import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { macVendor, parseMacVendors } from '@/app/decoders/ble/vendor-records';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

async function fixture() {
	const bytes = new Uint8Array(30000 * 71);
	for (let i = 0; i < 30000; i++) {
		bytes.set(new TextEncoder().encode(i.toString(16).toUpperCase().padStart(6, '0')), i * 7);
		bytes.set(new TextEncoder().encode(`Vendor ${i}`), 30000 * 7 + i * 64);
	}
	const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
	const manifest = { schema: 1, revision: digest.slice(0, 24), count: 30000, bytes: bytes.length, sha256: digest };
	const stored = new Map();
	const cache = {
		match: async (key) => stored.get(key)?.clone(),
		put: async (key, response) => stored.set(key, response.clone()),
	};
	vi.stubGlobal('caches', { open: async () => cache });
	vi.stubGlobal('location', { href: 'http://localhost:5173/' });
	vi.stubGlobal('crypto', webcrypto);
	const fetch = vi.fn(async (url) => new Response(url.endsWith('manifest.json') ? JSON.stringify(manifest) : bytes));
	vi.stubGlobal('fetch', fetch);
	return { bytes, manifest, stored, cache, fetch };
}

describe('BLE MAC vendor database', () => {
	it('reads the actual PortaPack binary layout and limits identification to public addresses', async () => {
		const bytes = new Uint8Array(await readFile('public/ble-db/macaddress.db'));
		const db = parseMacVendors(bytes);
		expect(db.count).toBeGreaterThan(30000);
		expect(macVendor(db, { address: '00:00:0C:12:34:56', addressType: 'public' })).toBe('Cisco Systems, Inc');
		expect(macVendor(db, { address: '00:00:0C:12:34:56', addressType: 'random' })).toBeUndefined();
		expect(macVendor(db, { address: 'FF:FF:FF:FF:FF:FF', addressType: 'public' })).toBeUndefined();
		expect(macVendor(db, { address: '../invalid', addressType: 'public' })).toBeUndefined();
	});
	it('rejects truncation, invalid keys, unsorted keys and missing vendor terminators', () => {
		const bytes = new Uint8Array(142);
		bytes.set(new TextEncoder().encode('000001\0' + '000002\0'));
		bytes.set(new TextEncoder().encode('First'), 14);
		bytes.set(new TextEncoder().encode('Second'), 78);
		expect(parseMacVendors(bytes).count).toBe(2);
		expect(() => parseMacVendors(bytes.slice(1))).toThrow('size');
		bytes[0] = 71;
		expect(() => parseMacVendors(bytes)).toThrow('record');
		bytes[0] = 48;
		bytes[5] = 51;
		expect(() => parseMacVendors(bytes)).toThrow('record');
		bytes[5] = 49;
		bytes.fill(65, 78);
		expect(() => parseMacVendors(bytes)).toThrow('record');
	});
	it('deduplicates loads, validates hosted downloads and reuses the saved binary snapshot offline', async () => {
		const { fetch } = await fixture();
		let module = await import('@/app/decoders/ble/database');
		const [db, same] = await Promise.all([module.loadMacVendors(), module.loadMacVendors()]);
		expect(same).toBe(db);
		expect(macVendor(db, { address: '00:00:01:12:34:56', addressType: 'public' })).toBe('Vendor 1');
		expect(fetch).toHaveBeenCalledTimes(2);
		vi.resetModules();
		fetch.mockRejectedValue(new Error('offline'));
		module = await import('@/app/decoders/ble/database');
		expect((await module.loadMacVendors())?.count).toBe(30000);
		expect(fetch).toHaveBeenCalledTimes(4);
	});
	it('falls back to bundled data on hosted checksum failure and tolerates unavailable browser storage', async () => {
		const { bytes, manifest, fetch } = await fixture();
		vi.stubGlobal('caches', {
			open: async () => {
				throw new Error('storage denied');
			},
		});
		fetch.mockImplementation(async (url) => {
			if (url.endsWith('manifest.json')) return new Response(JSON.stringify(manifest));
			if (url.startsWith('http://localhost:5173/')) return new Response(bytes);
			return new Response(bytes.slice(1));
		});
		const { loadMacVendors } = await import('@/app/decoders/ble/database');
		expect((await loadMacVendors())?.count).toBe(30000);
		expect(fetch).toHaveBeenCalledTimes(4);
	});
	it('preserves the saved snapshot when a replacement fails and retries a failed initial load', async () => {
		const { bytes, manifest, stored, fetch } = await fixture();
		let module = await import('@/app/decoders/ble/database');
		await module.loadMacVendors();
		vi.resetModules();
		const corrupt = bytes.slice();
		corrupt[0] = 65;
		fetch.mockImplementation(async (url) => new Response(url.endsWith('manifest.json') ? JSON.stringify(manifest) : corrupt));
		module = await import('@/app/decoders/ble/database');
		expect((await module.loadMacVendors())?.count).toBe(30000);
		stored.clear();
		vi.resetModules();
		module = await import('@/app/decoders/ble/database');
		expect(await module.loadMacVendors()).toBeUndefined();
		fetch.mockImplementation(async (url) => new Response(url.endsWith('manifest.json') ? JSON.stringify(manifest) : bytes));
		expect((await module.loadMacVendors())?.count).toBe(30000);
	});
});
