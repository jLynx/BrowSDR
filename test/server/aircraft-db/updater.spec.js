import { env, fetchMock, createScheduledController } from 'cloudflare:test';
import { beforeAll, afterEach, describe, it, expect } from 'vitest';
import worker from '../../../src/server';
import { updateDatabase } from '../../../src/server/aircraft-db/update';
import { CsvReader } from '../../../src/server/aircraft-db/csv';
import { digest } from '../../../src/server/aircraft-db/format';
import { airlinesUrl } from '../../../src/server/aircraft-db/sources';
import { metadataListUrl, resolveAircraftUrl } from '../../../src/server/aircraft-db/discovery';

const aircraftUrl = 'https://s3.opensky-network.org/data-samples/metadata/aircraft-database-complete-2025-08.csv';
const listing = (entries, extra = '<IsTruncated>false</IsTruncated>') =>
	`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${entries.map(([key, size]) => `<Contents><Key>${key}</Key><Size>${size}</Size></Contents>`).join('')}${extra}</ListBucketResult>`;

function mockListing() {
	mockSource(metadataListUrl, listing([['metadata/aircraft-database-complete-2025-08.csv', 1000]]));
}

const aircraft =
	'icao24,registration,manufacturername,model,typecode,icaoaircrafttype,owner,operator\r\nC827EE,ZK-NNF,Airbus,A320,A320,L2J,Owner,Operator\r\nA4FA61,N42MH,Piper,"PA-31, test",PA31,L2P,,\r\nC827EE,ZK-NNF,,,,,,\r\n';
const airlines = '0MM,First airline,0M,New Zealand\r\nANZ,"Air New Zealand, Ltd",NZ,New Zealand\r\n';
const manifestKey = 'aircraft-db/manifest.json';
const sources = [
	{ url: aircraftUrl, sha256: digest(aircraft) },
	{ url: airlinesUrl, sha256: digest(airlines) },
];

function mockSource(url, body, times = 1, status = 200) {
	const target = new URL(url);
	fetchMock
		.get(target.origin)
		.intercept({ path: target.pathname + target.search })
		.reply(status, body)
		.times(times);
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('Cloudflare aircraft database cron', () => {
	it('skips all writes when source hashes match', async () => {
		const value = { schema: 1, revision: 'a'.repeat(24), sources, files: {} };
		const before = await env.AIRCRAFT_DB.put(manifestKey, JSON.stringify(value));
		mockListing();
		mockSource(aircraftUrl, aircraft);
		mockSource(airlinesUrl, airlines);
		expect(await updateDatabase(env.AIRCRAFT_DB)).toEqual({ changed: false, revision: value.revision });
		expect((await env.AIRCRAFT_DB.head(manifestKey)).etag).toBe(before.etag);
		expect((await env.AIRCRAFT_DB.list()).objects).toHaveLength(1);
	});

	it('scheduled handler publishes readable files, then manifest, and removes staging', async () => {
		mockListing();
		mockSource(aircraftUrl, aircraft, 2);
		mockSource(airlinesUrl, airlines, 2);
		await worker.scheduled(createScheduledController({ cron: '17 3 * * MON' }), env);
		const manifest = await (await env.AIRCRAFT_DB.get(manifestKey)).json();
		expect(manifest.sources).toEqual(sources);
		expect(manifest.files['aircraft-C8.db'].count).toBe(1);
		expect(manifest.files['aircraft-A4.db'].count).toBe(1);
		expect(manifest.files['airlines.db'].count).toBe(2);
		const file = manifest.files['aircraft-C8.db'];
		const data = new Uint8Array(await (await env.AIRCRAFT_DB.get(`aircraft-db/${file.path}`)).arrayBuffer());
		expect(digest(data)).toBe(file.sha256);
		expect(new TextDecoder().decode(data.slice(0, 16))).toBe('C827EE\0ZK-NNF\0\0\0');
		expect(data.byteLength).toBe(153);
		expect((await env.AIRCRAFT_DB.list({ prefix: 'aircraft-db-staging/' })).objects).toHaveLength(0);
	});

	it('retains manifest and immutable objects when only source ordering changes', async () => {
		mockListing();
		mockSource(aircraftUrl, aircraft, 2);
		mockSource(airlinesUrl, airlines, 2);
		await updateDatabase(env.AIRCRAFT_DB);
		const before = await env.AIRCRAFT_DB.get(manifestKey);
		const manifest = await before.json();
		const oldObject = await env.AIRCRAFT_DB.head(`aircraft-db/${manifest.files['airlines.db'].path}`);
		const reordered = airlines.trim().split('\r\n').reverse().join('\n');
		mockListing();
		mockSource(aircraftUrl, aircraft, 2);
		mockSource(airlinesUrl, reordered, 2);
		expect(await updateDatabase(env.AIRCRAFT_DB)).toEqual({ changed: false, revision: manifest.revision });
		expect((await env.AIRCRAFT_DB.head(manifestKey)).etag).toBe(before.etag);
		expect((await env.AIRCRAFT_DB.head(oldObject.key)).etag).toBe(oldObject.etag);
	});

	it('leaves the published manifest intact if a source fails', async () => {
		const before = await env.AIRCRAFT_DB.put(manifestKey, JSON.stringify({ schema: 1, revision: 'a'.repeat(24), sources, files: {} }));
		mockListing();
		mockSource(aircraftUrl, 'Unavailable', 1, 503);
		await expect(updateDatabase(env.AIRCRAFT_DB)).rejects.toThrow('HTTP 503');
		expect((await env.AIRCRAFT_DB.head(manifestKey)).etag).toBe(before.etag);
	});

	it('discovers the latest complete release across listing pages, ignoring incomplete dumps and timestamps', async () => {
		mockSource(
			metadataListUrl,
			listing(
				[
					['metadata/aircraftDatabase-2026-10.csv', 1000],
					['metadata/aircraft-database-complete-2024-04.csv', 1000],
					['metadata/aircraft-database-complete-2026-13.csv', 1000],
				],
				'<IsTruncated>true</IsTruncated><NextContinuationToken>next&amp;page</NextContinuationToken>',
			),
		);
		const page = new URL(metadataListUrl);
		page.searchParams.set('continuation-token', 'next&page');
		mockSource(
			page.href,
			listing([
				['metadata/aircraft-database-complete-2025-08.csv', 1000],
				['metadata/aircraft-database-complete-2026-01.csv', 1000],
				['metadata/aircraft-database-complete-2026-02.csv', 0],
			]),
		);
		expect(await resolveAircraftUrl()).toBe(aircraftUrl.replace('2025-08', '2026-01'));
	});

	it('keeps the saved manifest if discovery fails instead of choosing an old incomplete dump', async () => {
		const before = await env.AIRCRAFT_DB.put(manifestKey, JSON.stringify({ schema: 1, revision: 'a'.repeat(24), sources, files: {} }));
		mockSource(metadataListUrl, listing([['metadata/aircraftDatabase.csv', 1000]]));
		await expect(updateDatabase(env.AIRCRAFT_DB)).rejects.toThrow('No complete');
		expect((await env.AIRCRAFT_DB.head(manifestKey)).etag).toBe(before.etag);
	});

	it('stops if the newest complete release is too large instead of silently selecting an older one', async () => {
		mockSource(
			metadataListUrl,
			listing([
				['metadata/aircraft-database-complete-2025-08.csv', 1000],
				['metadata/aircraft-database-complete-2026-01.csv', 257 * 1024 * 1024],
			]),
		);
		await expect(resolveAircraftUrl()).rejects.toThrow('size limit');
	});

	it('builds the single-quoted complete CSV with camelCase headers and quoted commas', async () => {
		const complete =
			"'icao24','registration','manufacturerName','model','typecode','icaoAircraftClass','owner','operator'\n'C827EE','ZK-NNF','Airbus','A320, test','A320','L2J','Owner''s aircraft','Operator'\n";
		mockListing();
		mockSource(aircraftUrl, complete, 2);
		mockSource(airlinesUrl, airlines, 2);
		await updateDatabase(env.AIRCRAFT_DB);
		const manifest = await (await env.AIRCRAFT_DB.get(manifestKey)).json();
		const data = await (await env.AIRCRAFT_DB.get(`aircraft-db/${manifest.files['aircraft-C8.db'].path}`)).text();
		expect(data).toContain('A320, test\0');
		expect(data).toContain("Owner's aircraft\0");
		expect(data).toContain('L2J\0');
		expect(manifest.sources[0]).toEqual({ url: aircraftUrl, sha256: digest(complete) });
	});

	it('fails closed for malformed published metadata and malformed CSV', async () => {
		await env.AIRCRAFT_DB.put(manifestKey, '{}');
		await expect(updateDatabase(env.AIRCRAFT_DB)).rejects.toThrow('Invalid published manifest');
		const rows = [];
		const parser = new CsvReader((row) => rows.push(row));
		for (const chunk of ['"one, two","quoted "', '"text""\nnext"\r', '\nplain,end']) parser.write(chunk);
		parser.finish();
		expect(rows).toEqual([
			['one, two', 'quoted "text"\nnext'],
			['plain', 'end'],
		]);
		const invalid = new CsvReader(() => {});
		invalid.write('"unterminated');
		expect(() => invalid.finish()).toThrow('Unterminated');
	});
});
