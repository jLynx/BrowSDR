import { describe, expect, it, vi } from 'vitest';
import { publishedManifest, snapshotChanged } from '../../scripts/aircraft-db/publication.mjs';

describe('database publication change detection', () => {
	it('skips an unchanged database even when its build timestamp changes', () => {
		const revision = 'a'.repeat(24);
		expect(snapshotChanged({ revision, builtAt: 'yesterday' }, { revision, builtAt: 'today' })).toBe(false);
		expect(snapshotChanged({ revision }, { revision: 'b'.repeat(24) })).toBe(true);
		expect(snapshotChanged(undefined, { revision })).toBe(true);
	});
	it.each(['https://example.com/db', 'https://example.com/db/'])('checks the manifest inside database directory %s', async (base) => {
		const request = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
		await publishedManifest(base, request);
		expect(request.mock.calls[0][0].pathname).toBe('/db/manifest.json');
	});
	it('treats only a missing manifest as the first publication and stops on service failures', async () => {
		const request = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
		expect(await publishedManifest('https://example.com/db/', request)).toBeUndefined();
		request.mockResolvedValue(new Response(null, { status: 503 }));
		await expect(publishedManifest('https://example.com/db/', request)).rejects.toThrow('503');
		request.mockResolvedValue(new Response(JSON.stringify({ schema: 1, revision: 'a'.repeat(24) })));
		expect(await publishedManifest('https://example.com/db/', request)).toMatchObject({ revision: 'a'.repeat(24) });
	});
});
