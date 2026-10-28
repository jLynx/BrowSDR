/*
 * FLEX codepage identities (7-bit, 128 codes) -- RX decode selection.
 *
 * FLEX_CHARSETS lists the selectable identities { vendor, model, codepage };
 * the glyph tables live in ./flex-tables and are re-exported here. The Kanji
 * identity is not a glyph table -- it attaches the 'kanji' handler that
 * switches FLEX alpha extraction to 16-bit Shift-JIS (FLEX carries no on-wire
 * signal for 16-bit payloads, so it is user-selected).
 *
 * The Motorola Linguist sets are ported from osmocom-analog
 * src/libpagercharset/charset_flex_motorola_linguist_*.c.
 */

import type { CharsetEntry } from './types';

export { FLEX_TABLES } from './flex-tables';

export const FLEX_CHARSETS: CharsetEntry[] = [
	{ vendor: 'generic', model: 'generic', codepage: 'ascii', codeBits: 7, label: 'Generic -- ASCII', tableId: 'generic-ascii' },
	{
		vendor: 'generic',
		model: 'generic',
		codepage: 'kanji',
		codeBits: 16,
		label: 'Kanji (Shift-JIS)',
		tableId: 'generic-ascii',
		handler: 'kanji',
	},
	{
		vendor: 'motorola',
		model: 'linguist',
		codepage: 'cyrillic',
		codeBits: 7,
		label: 'Motorola Linguist -- Cyrillic',
		tableId: 'motorola-linguist-cyrillic',
	},
	{
		vendor: 'motorola',
		model: 'linguist',
		codepage: 'icelandic',
		codeBits: 7,
		label: 'Motorola Linguist -- Icelandic',
		tableId: 'motorola-linguist-icelandic',
	},
	{
		vendor: 'motorola',
		model: 'linguist',
		codepage: 'polish',
		codeBits: 7,
		label: 'Motorola Linguist -- Polish',
		tableId: 'motorola-linguist-polish',
	},
	{
		vendor: 'motorola',
		model: 'linguist',
		codepage: 'vietnamese',
		codeBits: 7,
		label: 'Motorola Linguist -- Vietnamese',
		tableId: 'motorola-linguist-vietnamese',
	},
	{
		vendor: 'motorola',
		model: 'linguist',
		codepage: 'arabic',
		codeBits: 7,
		label: 'Motorola Linguist -- Arabic',
		tableId: 'motorola-linguist-arabic',
	},
	{
		vendor: 'motorola',
		model: 'linguist',
		codepage: 'arabic-english',
		codeBits: 7,
		label: 'Motorola Linguist -- Arabic/English',
		tableId: 'motorola-linguist-arabic-english',
	},
	{
		vendor: 'motorola',
		model: 'linguist',
		codepage: 'turkish',
		codeBits: 7,
		label: 'Motorola Linguist -- Turkish',
		tableId: 'motorola-linguist-turkish',
	},
	{
		vendor: 'motorola',
		model: 'linguist',
		codepage: 'hebrew',
		codeBits: 7,
		label: 'Motorola Linguist -- Hebrew',
		tableId: 'motorola-linguist-hebrew',
	},
	{
		vendor: 'motorola',
		model: 'linguist',
		codepage: 'greek',
		codeBits: 7,
		label: 'Motorola Linguist -- Greek',
		tableId: 'motorola-linguist-greek',
	},
	{
		vendor: 'motorola',
		model: 'linguist',
		codepage: 'iso-8859-1',
		codeBits: 7,
		label: 'Motorola Linguist -- Latin-1 (ISO 8859-1)',
		tableId: 'motorola-linguist-iso-8859-1',
	},
	{
		vendor: 'motorola',
		model: 'linguist',
		codepage: 'iso-8859-2',
		codeBits: 7,
		label: 'Motorola Linguist -- Latin-2 (ISO 8859-2)',
		tableId: 'motorola-linguist-iso-8859-2',
	},
	{
		vendor: 'motorola',
		model: 'linguist',
		codepage: 'iso-8859-3',
		codeBits: 7,
		label: 'Motorola Linguist -- Latin-3 (ISO 8859-3)',
		tableId: 'motorola-linguist-iso-8859-3',
	},
	{
		vendor: 'motorola',
		model: 'linguist',
		codepage: 'iso-8859-4',
		codeBits: 7,
		label: 'Motorola Linguist -- Latin-4 (ISO 8859-4)',
		tableId: 'motorola-linguist-iso-8859-4',
	},
];
