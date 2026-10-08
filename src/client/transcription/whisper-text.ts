// Known non-speech output from Whisper on silence or damaged radio audio.
const HALLUCINATION_PATTERNS: RegExp[] = [
	/^\s*(you|a|um+|uh+|hmm*|hm+|ah+|oh|eh|mhm)\s*[.!?,]*\s*$/i,
	/thank you (for watching|very much|for joining)[.!]?\s*$/i,
	/please (like|subscribe|share|follow)[.!]?\s*$/i,
	/(don't forget to (like|subscribe|share))/i,
	/\[?\(?(music|applause|laughter|background noise|silence|inaudible|crosstalk|beep|static)\)?\]?\s*$/i,
	/^\s*(?:\[(?:blank_audio|sounds? of .+|speaking in .+)\]|\((?:speaking in .+|(?:audience )?(?:laughs|laughing))\))\s*[.!?]*\s*$/i,
	/^[\s.…\-_*~]+$/,
	/(.)\1{4,}/,
	/(\b\w+\b)(\s+\1){3,}/i,
];

export function isHallucination(text: string): boolean {
	return HALLUCINATION_PATTERNS.some((pattern) => pattern.test(text));
}
