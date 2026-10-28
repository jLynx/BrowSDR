/** GSC (Golay Sequential Code) decoder message and status types. */

/** Per-character decode confidence for GSC, parallel to a message's text. */
export const GSC_CHAR_OK = 0;
export const GSC_CHAR_CORRECTED = 1;
export const GSC_CHAR_UNCORRECTABLE = 2;

/** A decoded GSC (Golay Sequential Code) message. GSC has a single Table VII
 * character set, so there is no charset/codepage field. */
export interface GSCMessage {
	protocol: 'gsc';
	/** 7-digit functional address: I G1 G0 A2 A1 A0 suffix. */
	address: string;
	/** Address number 1-4 (derived from the function bits). */
	addressNumber: number;
	type: 'alpha' | 'numeric' | 'tone' | 'voice';
	text: string;
	/** Per-character confidence parallel to text: 0 ok, 1 corrected, 2 bad. */
	charStatus: number[];
	/** Corrected error count (Golay/BCH corrections applied). */
	errorCount: number;
	/** Uncorrectable codeword count (FEC decode failed). */
	uncorrectableCount: number;
	/** Preamble index 0-9. */
	preambleIndex: number;
	/** True when this message was decoded at inverted signal polarity. Part of
	 * the message IDENTITY: the same address at normal vs inverted polarity is
	 * two distinct subscribers (operators run both to double the address space),
	 * so any future dedup/retransmission collapse MUST key on address+polarity,
	 * never address alone. */
	inverted?: boolean;
	/**
	 * Runner-up interpretation (the other of alpha/numeric), present only when
	 * the "show second guess" option is on. GSC discriminates alpha vs numeric
	 * by content score, so the losing reading is a meaningful second guess. The
	 * UI renders it dimmed beside the primary text.
	 */
	alt?: { type: 'alpha' | 'numeric'; text: string };
	/** For voice pages: 'start' when the voice alert batch is decoded, 'stop'
	 * when the transmission ends. Undefined for data/tone pages. */
	voiceEvent?: 'start' | 'stop';
	/** Why a voice page ended (on the 'stop' event): the activation (stop) code,
	 * a new preamble, silence (TX stopped), or the recording timeout. */
	voiceEndReason?: 'activation' | 'preamble' | 'silence' | 'timeout';
}

/** The set of reasons a GSC voice page can end. */
export type GSCVoiceEndReason = 'activation' | 'preamble' | 'silence' | 'timeout';

/** Live link status for a GSC VFO (sync / polarity / bit-error rate). */
export interface GSCStatus {
	synced: boolean;
	baud: number | null;
	/** True when the locked signal is inverted polarity. */
	inverted: boolean;
	ber: number | null;
	codewords: number;
	/** Locked sub-stage (what is being received), or null while hunting:
	 * 'data' = collecting a data batch, 'voice' = a voice-alert page is active.
	 * Mirrors the FLEX pipeline-stage chip. */
	stage?: 'data' | 'voice' | null;
	/** Last known BER carried forward for display during hunt. */
	lastBer?: number | null;
}

/** GSC receiver sync state. */
export type GSCRxState = 'idle' | 'preamble' | 'collect' | 'voice';
