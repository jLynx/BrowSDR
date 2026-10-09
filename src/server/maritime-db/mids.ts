import { createHash } from 'node:crypto';

export const MID_SOURCE = 'https://www.itu.int/en/ITU-R/terrestrial/fmd/Pages/mid.aspx';
export const MID_TABLE = 'https://www.itu.int/gladapp/Allocation/MIDs';
export const MID_KEY = 'maritime-db/mids.json';

function text(html: string): string {
	return html
		.replace(/<[^>]*>/g, ' ')
		.replace(/&#(x[\da-f]+|\d+);/gi, (_match: string, value: string) =>
			String.fromCodePoint(value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : parseInt(value, 10)),
		)
		.replace(/&amp;/g, '&')
		.replace(/&nbsp;/g, ' ')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

/** The ITU landing page embeds this server-rendered allocation table. No vessel registry is implied. */
export function parseMids(html: string, minimum = 280): Record<string, string> {
	const allocations = new Map<string, Set<string>>();
	for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
		const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => text(cell[1]));
		if (cells.length !== 2 || !/^[2-7]\d{2}(?:\s+[2-7]\d{2})*$/.test(cells[0]) || !cells[1] || cells[1].length > 160) continue;
		for (const mid of cells[0].split(/\s+/)) {
			const countries = allocations.get(mid) ?? new Set<string>();
			countries.add(cells[1]);
			allocations.set(mid, countries);
		}
	}
	if (allocations.size < minimum) throw new Error('ITU MID table incomplete or changed; keeping the published database');
	// Some territories share an MID (306). Retain every allocation rather than choosing one territory.
	const mids = Object.fromEntries(
		[...allocations].sort(([a], [b]) => a.localeCompare(b)).map(([mid, countries]) => [mid, [...countries].sort().join('; ')]),
	);
	if (Object.values(mids).some((country) => country.length > 512)) throw new Error('ITU shared MID allocation exceeds size limit');
	return mids;
}

export function midRevision(mids: Record<string, string>): string {
	return createHash('sha256').update(JSON.stringify(mids)).digest('hex').slice(0, 24);
}
