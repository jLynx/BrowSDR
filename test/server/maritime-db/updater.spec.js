import { env, fetchMock } from 'cloudflare:test';
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { updateMaritimeDatabase } from '../../../src/server/maritime-db/update';
import { MID_KEY, MID_TABLE, parseMids } from '../../../src/server/maritime-db/mids';

const table = (name = 'Country') =>
	'<table>' +
	Array.from({ length: 292 }, (_, i) => `<tr><td><span>${201 + i}</span></td><td>${name} &amp; ${i}</td></tr>`).join('') +
	'</table>';
function mock(body, status = 200) {
	const url = new URL(MID_TABLE);
	fetchMock.get(url.origin).intercept({ path: url.pathname }).reply(status, body);
}
beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('ITU MID database publication', () => {
	it('parses grouped MIDs, preserves shared allocations and rejects incomplete tables', () => {
		expect(parseMids(table())['201']).toBe('Country & 0');
		const grouped = '<tr><td><span>563</span><span>564</span><span>565</span><span>566</span></td><td>Singapore (Republic of)</td></tr>';
		const mids = parseMids(table() + grouped);
		for (const mid of ['563', '564', '565', '566']) expect(mids[mid]).toBe('Singapore (Republic of)');
		expect(() => parseMids('<tr><td>201</td><td>Albania</td></tr>')).toThrow('incomplete');
		const shared =
			'<tr><td>306</td><td>Netherlands (Kingdom of the) - Cura&#231;ao</td></tr>' +
			'<tr><td>306</td><td>Netherlands (Kingdom of the) - Sint Maarten (Dutch part)</td></tr>';
		expect(parseMids(shared, 1)['306']).toBe(
			'Netherlands (Kingdom of the) - Curaçao; Netherlands (Kingdom of the) - Sint Maarten (Dutch part)',
		);
	});
	it('publishes country allocations, skips unchanged content and preserves data on upstream failure', async () => {
		mock(table());
		expect((await updateMaritimeDatabase(env.DATABASES)).changed).toBe(true);
		const before = await env.DATABASES.get(MID_KEY);
		const value = await before.json();
		expect(value.mids['201']).toBe('Country & 0');
		mock(table());
		expect(await updateMaritimeDatabase(env.DATABASES)).toEqual({ changed: false, revision: value.revision });
		expect((await env.DATABASES.head(MID_KEY)).etag).toBe(before.etag);
		mock('Unavailable', 503);
		await expect(updateMaritimeDatabase(env.DATABASES)).rejects.toThrow('HTTP 503');
		expect((await env.DATABASES.head(MID_KEY)).etag).toBe(before.etag);
		mock('<html>Changed layout</html>');
		await expect(updateMaritimeDatabase(env.DATABASES)).rejects.toThrow('incomplete');
		expect((await env.DATABASES.head(MID_KEY)).etag).toBe(before.etag);
	});
});
