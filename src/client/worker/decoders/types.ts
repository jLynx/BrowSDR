/** Pager protocol message/status types. Re-exported here so the many existing
 * `@/worker/decoders/types` importers keep working; the definitions now live in
 * each protocol's own file (POCSAG and GSC as peers of the FLEX module). */
export { GSC_CHAR_OK, GSC_CHAR_CORRECTED, GSC_CHAR_UNCORRECTABLE } from './gsc.types';
export type { GSCMessage, GSCVoiceEndReason, GSCStatus, GSCRxState } from './gsc.types';
export { POCSAG_CHAR_OK, POCSAG_CHAR_CORRECTED, POCSAG_CHAR_UNCORRECTABLE } from './pocsag.types';
export type { POCSAGMessage, PocsagMode, POCSAGStatus } from './pocsag.types';
export type { FlexMessage } from './flex/types';
export type { FlexRxStage, FlexStatus } from './flex/types';

export type Rtl433Message =
	{ type: 'rtl433_event'; freq: number; event: Record<string, unknown> } | { type: 'rtl433_status'; freq?: number; status: Rtl433Status };

export interface Rtl433Protocol {
	id: number;
	name: string;
	disabled: boolean;
}

export interface Rtl433Status {
	state: 'off' | 'loading' | 'receiving' | 'error';
	message: string;
	sampleRate: number;
	samples: number;
	events: number;
	protocols?: Rtl433Protocol[];
}

export interface RtlModule {
	HEAPF32: Float32Array;
	_malloc(bytes: number): number;
	_free(ptr: number): void;
	stringToNewUTF8(text: string): number;
	UTF8ToString(ptr: number): string;
	_rtl433_init(rate: number, frequency: number, protocols: number): number;
	_rtl433_process(ptr: number, count: number): number;
	_rtl433_flush(): number;
	_rtl433_destroy(): void;
	_rtl433_protocol_count(): number;
	_rtl433_protocol_name(id: number): number;
	_rtl433_protocol_disabled(id: number): number;
}

export type RtlFactory = (options: {
	locateFile(path: string): string;
	onDecoded(json: string): void;
	print(): void;
	printErr(): void;
}) => Promise<RtlModule>;

export interface MbelibModule {
	HEAP8: Int8Array;
	HEAPF32: Float32Array;
	_malloc(this: void, size: number): number;
	_free(this: void, ptr: number): void;
	cwrap(name: string, result: 'number', args: ['number', 'number']): (frame: number, audio: number) => number;
	cwrap(name: string, result: null, args: []): () => void;
}

export type MbelibFactory = (options: { locateFile(path: string): string }) => Promise<MbelibModule>;

export interface SidebandState {
	ssbPhase?: number;
	agcGain?: number;
}

export interface RDSMessage {
	ps?: string;
	psCharStatus?: number[]; // per-char: 0=clean, 1=corrected, 2=lost
	rt?: string;
	rtCharStatus?: number[]; // per-char quality
	ptyn?: string;
	ptynCharStatus?: number[]; // per-char quality
	pi?: string;
	piCc?: number; // PI bits [15:12]: country code nibble (1-F, 0=invalid)
	piCoverage?: number; // PI bits [11:8]: coverage area code
	piCoverageName?: string; // Coverage area name (Local/National/Regional/etc.)
	piRef?: number; // PI bits [7:0]: programme reference (0x00=not assigned)
	piCallsign?: string; // RBDS only: decoded K/W callsign (null for RDS)
	// Group 0/15B -- MS and DI
	ms?: boolean; // Music(true) / Speech(false) switch
	di?: number; // Decoder Identification 4-bit codeword (assembled from 4 groups)
	diStereo?: boolean; // d0: true=stereo
	diArtHead?: boolean; // d1: true=artificial head
	diCompressed?: boolean; // d2: true=compressed
	diDynPty?: boolean; // d3: true=dynamic PTY switching
	pty?: number;
	ptyLabel?: string;
	tp?: boolean;
	ta?: boolean;
	// Group 1A
	ecc?: number; // Extended Country Code (0x00-0xFF)
	countryName?: string; // Resolved from PI+ECC (region-dependent)
	lic?: number; // Language Identification Code
	languageName?: string; // Resolved LIC name
	pin?: number; // Programme Item Number (scheduled time, raw 16-bit)
	pinDay?: number; // PIN decoded day-of-month (1-31, 0 = no valid PIN)
	pinHour?: number; // PIN decoded hour (0-23)
	pinMinute?: number; // PIN decoded minute (0-59)
	hasTmc?: boolean; // TMC service detected (Group 1A variant 1)
	tmcId?: number; // 12-bit TMC service identifier (variant 1)
	// Group 1A variant 0 -- ECC block extras
	la?: boolean; // Linkage Actuator (block C bit 15, all variants)
	opc?: number; // Operator Code from ECC variant (bits 11:8), non-zero = enhanced paging
	// Group 1A variant 2 -- Paging identification (OPC + PAC)
	pagingOpc?: number; // Operator Code (bits 11:8 of variant 2 payload)
	pagingPac?: number; // Paging Area Code (bits 5:0 of variant 2 payload, 0=all areas)
	// Group 1A variant 6 -- Broadcaster use
	broadcasterData?: number; // 12-bit broadcaster-defined data
	// Group 1A variant 7 -- EWS
	ewsChannel?: number; // Emergency Warning System channel ID (12-bit)
	// Group 1A block B -- Radio Paging Codes (EN 50067 Annex M)
	rpc?: number; // Full 5-bit RPC value (bits 4:0 of block B)
	rpcGroupDesig?: number; // Transmitter network group designation (bits 4:2, 0=no paging)
	rpcBattSync?: number; // Battery-saving interval sync (bits 1:0)
	// Group 3A (ODA)
	odaAid?: number; // Open Data Application ID registered on a group
	odaGroup?: number; // Group number carrying this ODA (0-15)
	odaVersion?: number; // Group version (0=A, 1=B)
	odaMsg?: number; // 3A message bits (block C) -- app-specific config (e.g. RT+ template)
	// Group 4A (CT)
	ct?: string; // Clock time formatted "YYYY-MM-DD HH:MM" local
	ctUtcOffset?: number; // UTC offset in half-hours (signed)
	// Source metadata -- attached to every callback so the log can show origin
	srcGroup?: string; // e.g. "0A", "2A", "2B", "10A", "14B"
	srcAbFlag?: number; // A/B flag value (0 or 1) when present, -1 or absent otherwise
	odaData?: { group: number; version: number; b: number; c: number; d: number };
	// TMC (ODA AID 0x4D2C / 0xCD46 / 0xCD47)
	tmcMessage?: {
		event: number; // 11-bit event code (ISO 14819-2)
		location: number; // 16-bit location code
		direction: 'positive' | 'negative';
		extent: number; // 0-7: how many further locations affected
		duration: number; // duration code 0-7
		diversion: boolean; // diversion advised flag
		multi: boolean; // true=decoded from multi-group message
	};
	// Group 10A (PTYN) — already declared above with ptynCharStatus
	// Group 14A (EON)
	eon?: {
		pi: string;
		ps?: string;
		tp: boolean;
		ta: boolean;
		af?: number[];
		/** Mapped frequency pairs (variants 5-9): tuned freq TN -> other network freq ON */
		mappedFreqs?: Array<{ tuned: number; other: number }>;
		/** PTY of other network (variant 13) */
		ptyOn?: number;
		/** PIN of other network day/hour/minute (variant 14) */
		pinDay?: number;
		pinHour?: number;
		pinMinute?: number;
		/** Linkage Set Number and flags (variant 12) */
		lsn?: number; // 12-bit Linkage Set Number
		lsIls?: boolean; // International Linkage Set
		lsEg?: boolean; // Extended Generic flag
		lsLa?: boolean; // Linkage Actuator
	};
	// eRT (Enhanced RadioText, ODA AID 0x6552)
	eRT?: string; // decoded eRT text (up to 128 chars) -- complete message
	eRTPartial?: string; // in-progress eRT text while assembling
	eRTCharStatus?: number[]; // per-codepoint quality (0=ok, 1=corrected, 2=lost)
	// Group 3A RT+ ODA (AID 0x4BD7) and Group 11A RT+ data
	rtPlusRunning?: boolean; // item_running flag (true=item active)
	rtPlusToggle?: number; // item_toggle bit (0 or 1, change = new item)
	rtPlusItem1?: string; // Tag 1 text extracted from RT
	rtPlusItem1Tag?: number; // Tag 1 content type code (1-63)
	rtPlusItem1Name?: string; // Tag 1 content type name (e.g. "Title", "Artist")
	rtPlusItem2?: string; // Tag 2 text extracted from RT
	rtPlusItem2Tag?: number; // Tag 2 content type code
	rtPlusItem2Name?: string; // Tag 2 content type name
	// eRT+ (AID 0x4BD8): same tag format, independent state, source = eRT or RT per cb bit
	eRTPlusRunning?: boolean;
	eRTPlusToggle?: number;
	eRTPlusItem1?: string;
	eRTPlusItem1Tag?: number;
	eRTPlusItem1Name?: string;
	eRTPlusItem2?: string;
	eRTPlusItem2Tag?: number;
	eRTPlusItem2Name?: string;
	// Group 0A AF list
	af?: number[]; // Alternative frequencies in kHz
	afMethod?: 'A' | 'B'; // Which AF method was used (A=list, B=tuning pairs)
	// Group 7A Radio Paging (EN 50067 Annex M) — gated on rpcGroupDesig > 0
	paging?: { address: number; addrFmt: string; type: 'tone' | 'num10' | 'num18' | 'alpha' | 'vnum' | 'intl15' | 'functions'; data: string };
}

export interface RdsStatus {
	synced: boolean;
	ber: number;
	goodBlocks: number;
	correctedBlocks: number;
	totalBlocks: number;
	pilotLevel: number;
}

export interface RdsOdaCtx {
	readonly blocks: number[];
	readonly blockValid: boolean[];
	blockQuality(idx: number): number;
	lastRt: string;
	lastERT: string;
	callback(msg: RDSMessage): void;
}

/** Callback type for RDSDemodulator when a complete 4-block group is assembled. */
export type OnGroupCallback = (blocks: number[], blockValid: boolean[], blockCorrected: boolean[]) => void;
