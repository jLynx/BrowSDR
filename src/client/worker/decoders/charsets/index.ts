/*
 * Pager charset registry — resolves a protocol-scoped charset key to a glyph
 * table. POCSAG is populated (26 identities over 19 unique tables); FLEX is a
 * ready empty branch for a later pass.
 */

import type { CharsetEntry, CharsetKey, CharsetRegistry, CharsetTables, Codepage } from './types';
import { charsetKeyEquals } from './types';
import { POCSAG_CHARSETS, POCSAG_TABLES } from './pocsag';

export const CHARSETS: CharsetRegistry = {
	pocsag: POCSAG_CHARSETS,
	flex: [],
};

const TABLES: Record<'pocsag' | 'flex', CharsetTables> = {
	pocsag: POCSAG_TABLES,
	flex: {},
};

/** The default POCSAG charset key (generic ASCII). */
export const POCSAG_DEFAULT_CHARSET: CharsetKey = { vendor: 'generic', model: 'generic', codepage: 'ascii' };

/** Resolve a POCSAG charset key to its glyph table, falling back to ASCII. */
export function pocsagCodepage(key: CharsetKey): Codepage {
	const entry =
		POCSAG_CHARSETS.find((e) => charsetKeyEquals(e, key)) ?? POCSAG_CHARSETS.find((e) => charsetKeyEquals(e, POCSAG_DEFAULT_CHARSET));
	const id = entry?.tableId ?? 'generic-ascii';
	return TABLES.pocsag[id] ?? TABLES.pocsag['generic-ascii'];
}

export type { CharsetEntry, CharsetKey };
export { POCSAG_CHARSETS, POCSAG_TABLES } from './pocsag';
