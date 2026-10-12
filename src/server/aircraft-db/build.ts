import type { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { CsvReader } from './csv';
import { aircraftFields, airlineFields, database, digest } from './format';
import { airlinesUrl, download } from './sources';
import type { DatabaseFile, SourceDigest } from './types';

function prefer(previous: string[] | undefined, next: string[]) {
	if (!previous) return true;
	const completeness = (fields: string[]) => fields.filter(Boolean).length;
	const difference = completeness(next) - completeness(previous);
	if (difference) return difference > 0;
	for (let index = 0; index < next.length; index++) {
		if (next[index] !== previous[index]) return next[index] > previous[index];
	}
	return false;
}

function aircraftRows(accept: (key: string, row: string[]) => void) {
	let columns: string[] | undefined;
	return new CsvReader((row) => {
		if (!columns) {
			columns = row.map((name) =>
				name
					.replace(/^\uFEFF/, '')
					.toLowerCase()
					.replace(/^icaoaircraftclass$/, 'icaoaircrafttype'),
			);
			const required = ['icao24', 'registration', 'manufacturername', 'model', 'typecode', 'icaoaircrafttype', 'owner', 'operator'];
			if (!required.every((name) => columns?.includes(name))) throw new Error('Unsupported aircraft CSV header');
			return;
		}
		const value = (name: string) => row[columns!.indexOf(name)] || '';
		const key = value('icao24').trim().toUpperCase();
		if (!/^[A-F0-9]{6}$/.test(key) || !value('registration')) return;
		const category = value('icaoaircrafttype');
		accept(key, [
			value('registration'),
			value('manufacturername'),
			value('model'),
			category.length === 3 ? category : value('typecode'),
			value('owner'),
			value('operator'),
		]);
	}, 'auto');
}

/** Spool selected fields in bounded blocks; never retain the full CSV in memory. */
async function stageAircraft(bucket: R2Bucket, root: string, aircraftUrl: string) {
	const pending = new Map<string, string[]>();
	const blocks = new Map<string, string[]>();
	let characters = 0;
	const parser = aircraftRows((key, row) => {
		const prefix = key.slice(0, 2);
		const line = JSON.stringify([key, row]);
		const lines = pending.get(prefix) || [];
		lines.push(line);
		pending.set(prefix, lines);
		characters += line.length;
	});
	async function flush(prefix: string) {
		const lines = pending.get(prefix)!;
		const paths = blocks.get(prefix) || [];
		const path = `${root}/source-${prefix}-${paths.length}`;
		await bucket.put(path, lines.join('\n'));
		paths.push(path);
		blocks.set(prefix, paths);
		for (const line of lines) characters -= line.length;
		pending.delete(prefix);
	}
	const source = await download(aircraftUrl);
	const reader = (source.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	const hash = createHash('sha256');
	let bytes = 0;
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		bytes += chunk.value.length;
		if (bytes > 256 * 1024 * 1024) {
			await reader.cancel();
			throw new Error('Aircraft source exceeds size limit');
		}
		hash.update(chunk.value);
		parser.write(decoder.decode(chunk.value, { stream: true }));
		if (characters > 4 * 1024 * 1024) {
			const largest = [...pending].sort(([, a], [, b]) => b.length - a.length)[0][0];
			await flush(largest);
		}
	}
	parser.write(decoder.decode());
	parser.finish();
	for (const prefix of pending.keys()) await flush(prefix);
	if (!blocks.size) throw new Error('Aircraft source produced no valid records');
	return { blocks, source: { url: aircraftUrl, sha256: hash.digest('hex') } };
}

async function stageAirlines(bucket: R2Bucket, root: string) {
	const response = await download(airlinesUrl);
	const bytes = await response.arrayBuffer();
	if (bytes.byteLength > 4 * 1024 * 1024) throw new Error('Airline source exceeds size limit');
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		text = new TextDecoder('windows-1252').decode(bytes);
	}
	const records = new Map<string, string[]>();
	const parser = new CsvReader((row) => {
		const key = (row[0] || '').trim().toUpperCase();
		if (row.length < 4 || !/^[A-Z0-9]{3}$/.test(key)) return;
		const record = [row[1].trim(), row[3].trim()];
		const previous = records.get(key);
		if (!previous || record[0] > previous[0] || (record[0] === previous[0] && record[1] > previous[1])) records.set(key, record);
	});
	parser.write(text);
	parser.finish();
	if (!records.size) throw new Error('Airline source produced no valid records');
	return {
		file: await stageFile(bucket, root, 'airlines.db', database(records, 4, airlineFields), records.size),
		source: { url: airlinesUrl, sha256: digest(new Uint8Array(bytes)) },
	};
}

async function stageFile(bucket: R2Bucket, root: string, name: string, data: Buffer, count: number): Promise<DatabaseFile> {
	if (data.length > 25 * 1024 * 1024) throw new Error('Database shard exceeds size limit');
	const sha256 = digest(data);
	const path = `${root}/${name}`;
	await bucket.put(path, data, { sha256 });
	return { path, bytes: data.length, count, sha256 };
}

export async function buildDatabase(bucket: R2Bucket, root: string, aircraftUrl: string) {
	const aircraft = await stageAircraft(bucket, root, aircraftUrl);
	const files: Record<string, DatabaseFile> = {};
	for (const [prefix, paths] of aircraft.blocks) {
		const records = new Map<string, string[]>();
		for (const path of paths) {
			const object = await bucket.get(path);
			if (!object) throw new Error('Missing staged aircraft block');
			for (const line of (await object.text()).split('\n')) {
				const [key, row] = JSON.parse(line) as [string, string[]];
				if (prefer(records.get(key), row)) records.set(key, row);
				if (records.size > 75000) throw new Error('Aircraft shard exceeds memory safety limit');
			}
			await bucket.delete(path);
		}
		const name = `aircraft-${prefix}.db`;
		files[name] = await stageFile(bucket, root, name, database(records, 7, aircraftFields), records.size);
	}
	const airlines = await stageAirlines(bucket, root);
	files['airlines.db'] = airlines.file;
	const sources: SourceDigest[] = [aircraft.source, airlines.source];
	return { files, sources };
}
