import { describe, expect, it } from 'vitest';
import { isHallucination } from '@/transcription/whisper-text';

describe('radio non-speech transcript filtering', () => {
	it.each(['[BLANK_AUDIO]', '[Sounds of children talking]', '(speaking in foreign language)', '(audience laughing)', '(laughs)'])(
		'discards the non-speech label %s',
		(text) => {
			expect(isHallucination(text)).toBe(true);
		},
	);
	it.each([
		'Roger.',
		'K46, returning to station.',
		'There are sounds of children talking in the background.',
		'We are speaking in English.',
	])('preserves actual speech: %s', (text) => {
		expect(isHallucination(text)).toBe(false);
	});
});
