/** POCSAG decoder message and status types. */

/** Per-character decode confidence, parallel to a message's text. */
export const POCSAG_CHAR_OK = 0; // all source bits from clean codewords
export const POCSAG_CHAR_CORRECTED = 1; // at least one source bit BCH-corrected
export const POCSAG_CHAR_UNCORRECTABLE = 2; // at least one source bit from an uncorrectable codeword

export interface POCSAGMessage {
	capcode: number;
	func: number;
	type: 'alpha' | 'tone' | 'numeric';
	text: string;
	/**
	 * Per-character confidence, one entry per character of `text`:
	 * 0 = ok, 1 = corrected (BCH-repaired), 2 = uncorrectable (data was lost /
	 * placeholder). Lets the UI colour-code characters. Empty for tone pages.
	 */
	charStatus: number[];
	baud: number;
	/** True when this message was decoded at inverted signal polarity. Part of
	 * the message IDENTITY: the same capcode at normal vs inverted polarity is
	 * two distinct subscribers (operators run both to double the capcode space),
	 * so any future dedup/retransmission collapse MUST key on capcode+polarity,
	 * never capcode alone. */
	inverted?: boolean;
	/** Debug: content-detection scores (alpha vs numeric), when DEBUG build. */
	detectDebug?: string;
	/**
	 * Runner-up interpretation (the other of alpha/numeric), present only in
	 * auto mode when the "show second guess" option is on. The UI renders it
	 * dimmed beside the primary text.
	 */
	alt?: { type: 'alpha' | 'numeric'; text: string };
}

/** POCSAG type-detection mode. */
export type PocsagMode = 'auto' | 'alpha' | 'numeric';

/**
 * Live link status for a POCSAG VFO (sync / speed / polarity / bit-error rate).
 * Emitted periodically by the decoder for a glanceable UI readout, independent
 * of decoded messages.
 */
export interface POCSAGStatus {
	/** True while a sub-decoder is locked onto a batch (receiving data). */
	synced: boolean;
	/** Baud rate of the locked sub-decoder, or null when not synced. */
	baud: number | null;
	/** True when the locked signal is inverted polarity. */
	inverted: boolean;
	/**
	 * Rolling bit-error rate (0..1): BCH-corrected bits / total data bits over
	 * the recent window of codewords. null until enough codewords are seen.
	 */
	ber: number | null;
	/** Codewords observed in the current rolling window (for UI confidence). */
	codewords: number;
	/** Locked sub-stage (what is being received), or null while hunting:
	 * 'batch' = reading a 16-codeword batch, 'page' = a multi-codeword page is
	 * in progress. Mirrors the FLEX pipeline-stage chip. */
	stage?: 'batch' | 'page' | null;
	/** Last known BER carried forward for display during hunt. */
	lastBer?: number | null;
}
