/** Types for the FLEX front end. */

/** FLEX receiver pipeline stage, surfaced for the live status bar. */
export type FlexRxStage = 'hunt' | 'sync1' | 'fiw' | 'sync2' | 'data';

/**
 * Live link status for a FLEX VFO. FLEX has a richer receiver state machine
 * than POCSAG/GSC: a PLL lock, a multi-stage sync pipeline (S1 -> FIW -> S2 ->
 * DATA), a selectable air mode (2/4FSK at 1600/3200 baud), signal polarity,
 * and running cycle/frame counters from the last decoded FIW.
 */
export interface FlexStatus {
	/** PLL symbol-timing lock. */
	locked: boolean;
	/** Current pipeline stage. */
	stage: FlexRxStage;
	/** Signal polarity: true when the air signal is inverted. */
	inverted: boolean;
	/** Air-mode label (e.g. "A4 (6400bps/4FSK)"), or null before sync. */
	mode: string | null;
	/** Data symbol rate in baud (1600 or 3200), or null before sync. */
	baud: number | null;
	/** Modulation levels: 2 (2FSK) or 4 (4FSK), or null before sync. */
	levels: number | null;
	/** Cycle number 0-14 from the last decoded FIW, or null. */
	cycle: number | null;
	/** Frame number 0-127 from the last decoded FIW, or null. */
	frame: number | null;
	/** Smoothed bit-error rate (0..1): errored bits (BCH-corrected + full
	 * codeword for uncorrectable) over received bits, or null before data. */
	ber: number | null;
	/** Simulcast local channel ID (9-bit, from BIW SSID1), or null. */
	localId: number | null;
	/** Coverage zone (5-bit, from BIW SSID1), or null. */
	coverageZone: number | null;
	/** Country code (from BIW SSID2), or null. */
	countryCode: number | null;
	/** SSID2 traffic-management flags (4-bit), or null. */
	tmf?: number | null;
	/** Network date "YYYY-MM-DD" from the last BIW DATE word, or null. */
	date: string | null;
	/** Network local time "HH:MM:SS" from the last BIW TIME word, or null. */
	time: string | null;
	/** Timezone offset from UTC in minutes (from BIW SysInfo TZ), or null. */
	tzOffsetMin: number | null;
	/** Daylight-saving active (from BIW SysInfo DST flag), or null. */
	dst?: boolean | null;
	/** Temporary-address (group) slots for the active polarity: 16 entries,
	 * each 'idle' | 'registered' | 'delivering', with target frame + members. */
	groupSlots?: Array<{ state: string; targetFrame: number; members: number[] }>;
	/** In-flight fragment reassembly buffers for the active polarity. */
	reasmBuffers?: number;
	/** Most recent non-mode sync-code detection (ERS or a reserved code), or
	 * null. ERS (Ar) is reported once per burst; reserved codes only on a
	 * 100%-error-free match. Carries a human label and the raw 16-bit code. */
	lastSyncEvent?: { label: string; code: number; ers: boolean } | null;
	/** Last known BER carried forward from previous status for display during hunt. */
	lastBer?: number | null;
	/** Resolution of the confirmed network time in seconds: 7.5 (coarse, TIME
	 * word only) or 0.9375 (refined, when the extended-seconds TZ/SysInfo word
	 * is also confirmed). Null when no time is confirmed (ARIB 3.7.2). */
	timePrecisionSec?: number | null;
}

/** A FLEX air mode, selected by the S1 sync code (frame.h FLEX_SYNC_Ax). */
export interface FlexMode {
	syncCode: number;
	/** Data symbol rate in baud (1600 or 3200). */
	baud: number;
	/** 2 for 2FSK, 4 for 4FSK. */
	levels: number;
	label: string;
}

/**
 * Decoded Frame Information Word (FIW). Mirrors the fields osmocom
 * flex_rx_decode_fiw extracts from the 21-bit BCH info field.
 */
export interface FlexFiw {
	/** Cycle number, 0-14. */
	cycle: number;
	/** Frame number, 0-127. */
	frame: number;
	/** Roaming allowed flag. */
	roaming: number;
	/** Multiple-transmission indicator (r bit). */
	repeat: number;
	/** 4-bit t field (low-traffic flags when r=0, tx params when r=1). */
	traffic: number;
	/** Number of transmissions: 1 (r=0), else 2/3/4. */
	numTransmissions: number;
	/** TD collapse override (5/6/7), or -1 for system. */
	tdCollapse: number;
}

/**
 * One of the four FLEX data phases (A/B/C/D). Each holds up to 88 decoded
 * 32-bit words (deinterleaved) with their per-word BCH status and
 * low-confidence bit masks. Mirrors osmocom flex_phase_data_t.
 */
export interface FlexPhaseData {
	words: Uint32Array;
	status: Int8Array;
	lowConfBitA: Uint32Array;
	lowConfBitB: Uint32Array;
	/** Alternate (integrate-and-dump) decoded words, used as BCH fallback. */
	altWords: Uint32Array;
	/** Received bits per word; absent on complete externally constructed frames. */
	receivedBits?: Uint8Array;
	/** Received bits in the alternate slicer, including replayed SYNC2 tail. */
	altReceivedBits?: Uint8Array;
	idleCount: number;
}

/** Callbacks the FLEX front end fires as it recovers symbols and decodes. */
export interface FlexFrontendEvents {
	/** Fired once per recovered symbol (0..3), polarity-rectified. */
	onSymbol?: (sym: number) => void;
	/** PLL lock transitions. */
	onLock?: (locked: boolean) => void;
	/** A valid S1 sync was detected and validated; carries the air mode. */
	onMode?: (mode: FlexMode, polarity: number) => void;
	/**
	 * A clean (error-free) S1 sync was detected whose outer code is NOT a
	 * functional mode (A1-A4): a Reserved code (A5-A15, including A7 which may
	 * be ReFLEX) or the Ar Emergency Re-synchronization code. Carries a label
	 * and the raw 16-bit outer code. Only fired on a zero-bit-error match, so a
	 * corrupted A1-A4 is never mislogged as reserved/ERS.
	 */
	onSyncCode?: (info: { code: number; label: string; ers: boolean; polarity: number }) => void;
	/** A valid FIW was decoded (after SYNC1, before SYNC2). */
	onFiw?: (fiw: FlexFiw) => void;
	/**
	 * A full or interrupted frame's phase buffers are ready for block/message
	 * decode; receivedBits distinguishes complete words from missing data.
	 * `activePhases` lists the phase-buffer indices this
	 * mode actually decodes: [0] for A1, [0,2] (A,C) for A2/A3, [0,1,2,3] for A4.
	 */
	onFrame?: (phases: FlexPhaseData[], activePhases: number[], fiw: FlexFiw, polarity: number) => void;
}

/** One decoded FLEX message from a single frame/phase. */
export interface FlexMessage {
	capcode: number;
	/** 'A'..'D'. */
	phase: string;
	cycle: number;
	frame: number;
	/** Vector type (FLEX_VECTOR_TYPE_*). */
	vectorType: number;
	/** Short label: ALPHA / NUM / SNUM / NNUM / TONE / SECURE / HEX / INSTR. */
	kind: string;
	/** Decoded text (alpha/numeric); empty for tone-only. */
	text: string;
	/** Per-character decode status parallel to text: 0 ok, 1 BCH-corrected
	 * (recovered), 2 bad (lost word). Empty for non-alpha or when unavailable. */
	charStatus?: number[];
	/** True when the address is a long (2-word) address. */
	long: boolean;
	/** Capcode class by address range: 'short', 'long', 'infoSvc' (mail drop),
	 * 'network', 'temporary' (group), 'operMsg', 'reserved'. */
	capClass?: 'short' | 'long' | 'infoSvc' | 'network' | 'temporary' | 'operMsg' | 'reserved' | 'unknown';
	/** For a temporary-address (group) delivery: the member capcodes learned
	 * from the slot's short-instruction assignments (empty if none seen yet). */
	groupMembers?: number[];
	/** True when the frame was received with inverted polarity. */
	inverted?: boolean;
	/**
	 * Fragment flag for alpha/secure messages: 'K' complete/unfragmented,
	 * 'F' a continued (more-follow) fragment, 'C' the final fragment; ' ' for
	 * message types that do not fragment. Used by the reassembler.
	 */
	frag?: string;
	/** Fragment message number N (0-63), or -1 when not applicable. */
	msgNum?: number;
	/** Raw 2-bit fragment number F (3=first/only, then 0,1,2 mod-3); internal
	 * to reassembly for missing-fragment detection. */
	hdrF?: number;
	/**
	 * True once the message is whole: either an unfragmented message or the
	 * fully reassembled multi-fragment result. A partial fragment is false.
	 */
	complete?: boolean;
	/**
	 * Alpha signature check (ARIB 3.10.1.3): true/false once validated, or null
	 * when not applicable or deferred mid-reassembly. The signature spans all
	 * fragments, so it is validated at reassembly completion.
	 */
	sigOk?: boolean | null;
	/**
	 * Per-fragment K checksum: true/false, or null when a body word was lost so
	 * it could not be verified. Validated immediately per fragment.
	 */
	kOk?: boolean | null;
	/** Received 7-bit signature (initial fragment); internal to reassembly. */
	rxSig?: number;
	/** Running 7-bit signature sum for this fragment; internal to reassembly. */
	sigSum?: number;
	/** False when a body word was lost, so the signature sum is incomplete. */
	sigValid?: boolean;
	/** Alpha/hex first fragment: mail-drop flag (M). Stored-message handling. */
	mailDrop?: boolean;
	/** Alpha/hex first fragment: retrieval flag (R). */
	retrieval?: boolean;
	/** Numbered numeric/special (V=111): message number N (0-63), displayed as
	 * N+1 by convention; -1 / absent when not a numbered message. */
	msgNumber?: number;
	/** Numbered numeric (V=111): R bit. true = new (sequence-checked) message,
	 * false = a retransmission of an earlier message number. */
	isNew?: boolean;
	/** Numbered numeric (V=111): S bit. true = special (ID-ROM) display format. */
	special?: boolean;
	/** Stable reassembly identity (`pol:capcode:msgNum`) for a fragmented alpha
	 * message, so the UI can update the same row in place across fragments. */
	reasmKey?: string;
	/** Number of fragments received so far (for the PARTIAL progress tag). */
	fragCount?: number;
	/** True when the message was emitted as an incomplete reassembly (abandoned
	 * by timeout or superseded) -- a valid partial, flagged so the UI marks it. */
	incomplete?: boolean;
	/** Deduplication tag for a complete message that matched the word-combine
	 * cache: 'dup' = exact retransmission, 'dup+' = improved retransmission
	 * (cleaner words merged in and re-decoded). Absent for a first/new message. */
	dedup?: 'dup' | 'dup+';
	/** Air-mode data rate in bps (1600/3200/6400) for the per-row mode tag. */
	baud?: number;
	/** FSK levels (2 or 4) for the per-row mode tag. */
	levels?: number;
	/**
	 * Calculated over-the-air timestamp (ARIB 3.7.2), attached when the network
	 * clock is available: the confirmed, consistency-voted date and/or time and
	 * timezone decoded from the BIW stream, e.g. "2026-10-26 15:42:00 +2h". Null
	 * when no clock component has been confirmed yet. This is the FLEX network's
	 * own time, distinct from the receiver's wall clock.
	 */
	flexTime?: string | null;
}
