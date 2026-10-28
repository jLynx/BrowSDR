import type { PagerProtocol } from '@/worker/decoders/charsets';

export interface PagerState {
	panelOpen: boolean;
	log: PagerLogEntry[];
	/** Row filter in the panel: a protocol id or 'all'. */
	filter: PagerProtocol | 'rds' | 'tmc' | 'all';
}

export type RdsStations = Record<
	number,
	{
		ps: string;
		rt: string;
		pi: string;
		pty: number;
		ptyLabel: string;
		tp: boolean | null;
		ta: boolean | null;
		freq: string;
		ptyn: string;
		ct: string;
		ctUtcOffset: number | null;
		ecc: number;
		countryName: string;
		lic: number;
		languageName: string;
		af: number[];
		afMethod: string;
		hasTmc: boolean;
		tmcId: number;
		rtPlusItem1: string;
		rtPlusItem1Tag: number;
		rtPlusItem1Name: string;
		rtPlusItem2: string;
		rtPlusItem2Tag: number;
		rtPlusItem2Name: string;
		rtPlusRunning: boolean;
		psCharStatus: number[];
		rtCharStatus: number[];
		// Group 1A extras
		la: boolean;
		opc: number;
		rpc: number;
		rpcGroupDesig: number;
		rpcBattSync: number;
		pagingOpc: number;
		pagingPac: number;
		ewsChannel: number;
		broadcasterData: number;
		pinDay: number;
		pinHour: number;
		pinMinute: number;
		// PI breakdown
		piCc: number;
		piCoverage: number;
		piCoverageName: string;
		piRef: number;
		piCallsign: string | null;
		// Group 0/15B MS + DI
		ms: boolean | null;
		di: number;
		diStereo: boolean;
		diArtHead: boolean;
		diCompressed: boolean;
		diDynPty: boolean;
		// eRT (Enhanced RadioText)
		eRT: string;
		eRTPartial: string;
		eRTCharStatus: number[];
		// eRT+ (ODA AID 0x4BD8) -- independent from RT+
		eRTPlusItem1: string;
		eRTPlusItem1Tag: number;
		eRTPlusItem1Name: string;
		eRTPlusItem2: string;
		eRTPlusItem2Tag: number;
		eRTPlusItem2Name: string;
		eRTPlusRunning: boolean;
		/** Map of PI -> EON network entry for display in station card */
		eonNetworks: Record<
			string,
			{
				pi: string;
				ps?: string;
				tp: boolean;
				ta: boolean;
				af?: number[];
				mappedFreqs?: Array<{ tuned: number; other: number }>;
				ptyOn?: number;
				pinDay?: number;
				pinHour?: number;
				pinMinute?: number;
				lsn?: number;
				lsIls?: boolean;
				lsEg?: boolean;
				lsLa?: boolean;
			}
		>;
	}
>;

export interface PagerLogEntry {
	/** Which pager protocol produced this message. 'rds' for RDS Group 7A pages, 'tmc' for RDS-TMC. */
	protocol: PagerProtocol | 'rds' | 'tmc';
	time: string;
	freq: string;
	vfoIndex: number;
	capcode: string;
	type: string;
	text: string;
	/** Per-character decode status parallel to text: 0 ok, 1 corrected, 2 bad. */
	charStatus?: number[];
	/** Signal polarity: true when decoded at inverted polarity. Shared across
	 * POCSAG, GSC, and FLEX; rendered as an INV/NORM row tag. */
	inverted?: boolean;

	// -- TMC-specific --
	/** TMC event code (11-bit, ISO 14819-2) */
	tmcEvent?: number;
	/** TMC location code (16-bit) */
	tmcLocation?: number;
	/** TMC direction: 'positive' | 'negative' */
	tmcDirection?: string;
	/** TMC extent (0-7: number of locations affected beyond primary) */
	tmcExtent?: number;
	/** TMC duration code (0-7) */
	tmcDuration?: number;
	/** TMC diversion advised flag */
	tmcDiversion?: boolean;

	// -- POCSAG-specific --
	/** Function sub-address 0-3 (shown as A-D). POCSAG-specific; optional. */
	func?: number;
	baud?: number;
	detectDebug?: string;
	/** Runner-up interpretation (second guess), shown dimmed when enabled. */
	alt?: { type: 'alpha' | 'numeric'; text: string };

	// -- GSC-specific --
	/** GSC: corrected (FEC-repaired) codeword count for the message. */
	errorCount?: number;
	/** GSC: uncorrectable codeword count (decode failed) for the message. */
	uncorrectableCount?: number;
	/** GSC voice page lifecycle: 'start' / 'stop'. */
	voiceEvent?: 'start' | 'stop';
	/** GSC: why the voice page ended (on a 'stop' event). */
	voiceEndReason?: 'activation' | 'preamble' | 'silence' | 'timeout';

	// -- FLEX-specific --
	/** FLEX: decoded phase 'A'..'D'. */
	phase?: string;
	/** FLEX: frame cycle number (0-14) this page was received in. */
	flexCycle?: number;
	/** FLEX: frame number (0-127) this page was received in. */
	flexFrame?: number;
	/** FLEX fragment flag: 'K' complete, 'F' continued, 'C' final. */
	frag?: string;
	/** FLEX: true once the message is whole (complete or fully reassembled). */
	complete?: boolean;
	/** FLEX alpha signature check: true ok, false bad, null n/a. */
	sigOk?: boolean | null;
	/** FLEX per-fragment K checksum: true ok, false bad, null n/a. */
	kOk?: boolean | null;
	/** FLEX: mail-drop flag (M). */
	mailDrop?: boolean;
	/** FLEX: retrieval flag (R) on an alpha first fragment. */
	retrieval?: boolean;
	/** FLEX numbered message number (0-63), displayed as N+1; absent otherwise. */
	msgNumber?: number;
	/** FLEX numbered: true = new message, false = retransmission. */
	isNew?: boolean;
	/** FLEX capcode class: short/long/infoSvc/network/temporary/operMsg/reserved. */
	capClass?: string;
	/** FLEX reassembly identity for in-place partial-row updates. */
	reasmKey?: string;
	/** FLEX fragments received so far (shown in the PARTIAL progress tag). */
	fragCount?: number;
	/** FLEX group delivery: member capcodes (from the slot's assignments). */
	groupMembers?: number[];
	/** FLEX: true when a reassembled message is missing fragment(s) (valid partial). */
	incomplete?: boolean;
	/** FLEX dedup tag: 'dup' = exact retransmission, 'dup+' = improved (word-combined). */
	dedup?: 'dup' | 'dup+';
	/** FLEX air-mode bitrate in bps (1600/3200/6400) for the mode tag. */
	flexBaud?: number;
	/** FLEX FSK levels (2 or 4) for the mode tag. */
	flexLevels?: number;
	/** FLEX calculated over-the-air (network) timestamp, or null/undefined when
	 * the network clock has not been confirmed. Shown as a per-row tag. */
	flexTime?: string | null;
}

export interface Rtl433LogEntry {
	time: string;
	freq: string;
	vfoIndex: number;
	event: Record<string, unknown>;
}

export interface RdsLogEntry {
	time: string;
	field: string;
	value: string;
	freq: string;
	vfoIndex: number;
	group?: string; // source group type e.g. "2A", "0A", "10A"
	abFlag?: number; // A/B flag value (0 or 1) when relevant
}
