/*
 * Pager character-set registry — hierarchical, protocol-scoped.
 *
 * A codepage is keyed by four fields: protocol → vendor → model → codepage.
 * Multiple paging protocols (POCSAG, FLEX, …) live as sibling branches so their
 * codepages never collide. These are RX-decode tables (primary display glyph
 * per code); TX-encode aliases are not represented here.
 */

/** Paging protocols that can own codepages. GSC uses a single fixed charset
 * (the Table VII alphabet, its default), so it has no SELECTABLE codepages and
 * appears here with an empty registry branch -- still a pager protocol peer. */
export type PagerProtocol = 'pocsag' | 'gsc' | 'flex';

/**
 * A codepage: code → display glyph. Index is the character code (0..N-1 where
 * N = 1 << code_bits; 128 for the 7-bit POCSAG/FLEX alphabet). `null` marks an
 * unmapped / control code.
 */
export type Codepage = Array<string | null>;

/**
 * A single registered charset identity. Multiple identities (different pager
 * models) can share one physical table, so the glyph table is referenced by id
 * rather than embedded — no duplication. The decoder for a given protocol
 * selects an identity by its protocol-implied sub-key { vendor, model,
 * codepage } and resolves `tableId` against the protocol's table map.
 */
export interface CharsetEntry {
	vendor: string; // e.g. "generic", "motorola", "nec", "philips", "swissphone"
	model: string; // e.g. "generic", "advisor", "maxima-compact", "prg2220"
	codepage: string; // e.g. "ascii", "latin-german", "cyrillic"
	codeBits: number; // 7 for POCSAG/FLEX
	label: string; // human-readable UI label
	tableId: string; // key into the protocol's shared table map
	/**
	 * Optional decode handler attached to this charset. A plain codepage needs
	 * none (it is a glyph-table remap). Some charsets instead attach behavior
	 * the table model cannot express: 'kanji' switches FLEX alpha extraction to
	 * 16-bit Shift-JIS, 'rot13' applies a ROT-13 transform (the Skyper pattern).
	 * The decoder reads this tag to select the handler.
	 */
	handler?: CharsetHandler;
}

/** A decode behavior a charset can attach beyond a glyph-table remap. */
export type CharsetHandler = 'kanji' | 'rot13';

/** Unique glyph tables for a protocol, keyed by tableId. */
export type CharsetTables = Record<string, Codepage>;

/** Protocol-implied sub-key used by a decoder to pick a charset. */
export interface CharsetKey {
	vendor: string;
	model: string;
	codepage: string;
}

/**
 * The registry: protocol → list of charsets under it. A protocol with no
 * populated codepages yet (e.g. FLEX in this pass) is a ready empty branch.
 */
export type CharsetRegistry = Record<PagerProtocol, CharsetEntry[]>;

/** True when a charset entry matches a protocol-implied sub-key. */
export function charsetKeyEquals(e: CharsetEntry, k: CharsetKey): boolean {
	return e.vendor === k.vendor && e.model === k.model && e.codepage === k.codepage;
}
