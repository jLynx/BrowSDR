import { describe, it, expect } from 'vitest';
import { resolveCodepage, CHARSETS } from '@/worker/decoders/charsets';

/*
 * FLEX codepages ported from osmocom-analog charset_flex_motorola_linguist_*.c.
 * Spot-check representative glyphs through the real registry resolver so the
 * ported tables are verified end to end (not just by the generator).
 */
describe('FLEX charset codepages', () => {
	it('registers the generic + 14 Linguist identities (incl. Kanji handler)', () => {
		const flex = CHARSETS.flex;
		// generic ascii + kanji + 13 Linguist glyph tables = 15 identities.
		expect(flex.length).toBe(15);
		expect(flex.some((e) => e.codepage === 'kanji' && e.handler === 'kanji')).toBe(true);
		expect(flex.some((e) => e.codepage === 'cyrillic')).toBe(true);
	});

	it('keeps ASCII in the printable range for the Latin/generic codepages', () => {
		// The Latin-N and generic tables keep ASCII letters/digits; the Cyrillic,
		// Greek, Arabic, Hebrew tables deliberately remap the letter range.
		const asciiKeeping = ['ascii', 'iso-8859-1', 'iso-8859-2', 'iso-8859-3', 'iso-8859-4', 'icelandic', 'polish', 'turkish'];
		for (const e of CHARSETS.flex) {
			if (e.handler || !asciiKeeping.includes(e.codepage)) continue;
			const cp = resolveCodepage('flex', e);
			expect(cp[0x41]).toBe('A');
			expect(cp[0x30]).toBe('0');
			expect(cp[0x20]).toBe(' ');
		}
	});

	it('maps Latin-1 (ISO 8859-1) low-code symbols per osmocom', () => {
		const cp = resolveCodepage('flex', { vendor: 'motorola', model: 'linguist', codepage: 'iso-8859-1' });
		expect(cp[0x01]).toBe('\u00a4'); // currency sign
		expect(cp[0x08]).toBe('\u00a3'); // pound sign
		expect(cp[0x09]).toBe('\u00b0'); // degree sign
		expect(cp[0x1c]).toBe('\u00a5'); // yen sign
	});

	it('remaps the letter range to Cyrillic per osmocom (0x41 -> a)', () => {
		const cyr = resolveCodepage('flex', { vendor: 'motorola', model: 'linguist', codepage: 'cyrillic' });
		expect(cyr[0x40]).toBe('\u044e'); // Cyrillic yu
		expect(cyr[0x41]).toBe('\u0430'); // Cyrillic a
		expect(cyr[0x20]).toBe(' '); // space still ASCII
		const grk = resolveCodepage('flex', { vendor: 'motorola', model: 'linguist', codepage: 'greek' });
		expect(grk.some((g, c) => c >= 0x40 && g != null && g.charCodeAt(0) > 0x7f)).toBe(true);
	});
});
