import { describe, expect, it } from 'vitest';
import { pocsagDisplayChar, pocsagDisplayText } from '@/app/decoders/pocsag';

/*
 * PR #49 review item 1 (jLynx): a carriage return must stay visible. The old
 * code mapped CR to an empty string, so HELLO\rWORLD displayed and exported as
 * HELLOWORLD — the message separator vanished. CR (like LF) now renders as the
 * return glyph ⏎.
 */
describe('POCSAG display — carriage-return separator', () => {
	it('renders CR as a visible return glyph, not nothing', () => {
		expect(pocsagDisplayChar('\r')).toBe('⏎');
	});

	it('keeps a CR-separated message from collapsing into one run', () => {
		expect(pocsagDisplayText('HELLO\rWORLD')).toBe('HELLO⏎WORLD');
	});

	it('renders LF as the return glyph too', () => {
		expect(pocsagDisplayChar('\n')).toBe('⏎');
	});

	it('still renders other control codes as <0xNN>', () => {
		expect(pocsagDisplayChar('\u0007')).toBe('<0x07>');
	});

	it('passes printable glyphs through unchanged', () => {
		expect(pocsagDisplayText('ABC 123')).toBe('ABC 123');
	});
});
