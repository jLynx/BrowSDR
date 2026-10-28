import { describe, expect, it } from 'vitest';
import { pagerDisplayChar, pagerDisplayText } from '@/app/decoders/pager';

/*
 * PR #49 review item 1 (jLynx): a carriage return must stay visible. The old
 * code mapped CR to an empty string, so HELLO\rWORLD displayed and exported as
 * HELLOWORLD -- the message separator vanished. CR (like LF) now renders as the
 * return glyph. This is shared pager display logic (POCSAG/GSC/FLEX).
 */
describe('pager display -- carriage-return separator', () => {
	it('renders CR as a visible return glyph, not nothing', () => {
		expect(pagerDisplayChar('\r')).toBe('\u23ce');
	});

	it('keeps a CR-separated message from collapsing into one run', () => {
		expect(pagerDisplayText('HELLO\rWORLD')).toBe('HELLO\u23ceWORLD');
	});

	it('renders LF as the return glyph too', () => {
		expect(pagerDisplayChar('\n')).toBe('\u23ce');
	});

	it('still renders other control codes as <0xNN>', () => {
		expect(pagerDisplayChar('\u0007')).toBe('<0x07>');
	});

	it('passes printable glyphs through unchanged', () => {
		expect(pagerDisplayText('ABC 123')).toBe('ABC 123');
	});
});
