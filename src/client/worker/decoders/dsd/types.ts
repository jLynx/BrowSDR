/*
 * DSD (Digital Speech Decoder) status and sync types.
 * Ported from SDR++ Brown ch_extravhf_decoder.
 *
 * Original DSD source: https://github.com/szechyjs/dsd
 * Copyright (C) 2010 DSD Author (ISC License)
 */

// ── Detected DSD mode ────────────────────────────────────────────────
export type DSDMode = 'dmr' | 'dstar' | 'p25' | 'nxdn' | 'unknown';

export interface DSDStatus {
	mode: DSDMode;
	synced: boolean;
	/** Which sync word was matched (e.g. "DMR_BS_VOICE") */
	syncName?: string;

	// ── mbelib state ──
	/** Whether mbelib WASM is loaded and ready */
	mbelibLoaded?: boolean;
	/** Voice codec assets failed to load or initialize. */
	mbelibError?: string;
	/** Whether MBE decoder is actively producing audio */
	mbeDecoding?: boolean;
	/** MBE error bar string (e.g. "======R") — one char per voice frame */
	mbeErrors?: string;
	/** Total voice frames decoded this session */
	voiceFrameCount?: number;
	/** Confirmed syncs and the most recent protocol, retained between bursts. */
	syncCount?: number;
	lastSyncName?: string;

	// ── DMR ──
	/** DMR color code (0-15) */
	colorCode?: number;
	/** DMR current slot (0 or 1) */
	slot?: number;
	/** DMR slot 0 burst type description */
	slot0Burst?: string;
	/** DMR slot 1 burst type description */
	slot1Burst?: string;

	// ── P25 ──
	/** P25 Network Access Code (12-bit) */
	nac?: number;
	/** P25 Data Unit ID type string */
	duid?: string;
	/** P25 Source ID */
	src?: number;
	/** P25 Talkgroup ID */
	tg?: number;
	/** P25 Emergency flag */
	emr?: boolean;
	/** P25 Algorithm ID (encryption) */
	algid?: number;

	// ── D-STAR ──
	/** D-STAR callsign (if decoded from header) */
	callsign?: string;

	// ── NXDN ──
	/** NXDN type description */
	nxdnType?: string;
}

// ── Frame sync state ─────────────────────────────────────────────────
export const enum SyncType {
	NONE = -1,
	P25P1 = 0,
	INV_P25P1 = 1,
	X2TDMA_BS_VOICE = 2,
	X2TDMA_BS_DATA = 3,
	X2TDMA_MS_VOICE = 4,
	X2TDMA_MS_DATA = 5,
	DSTAR = 6,
	INV_DSTAR = 7,
	NXDN_MS_DATA = 8,
	INV_NXDN_MS_DATA = 9,
	NXDN_MS_VOICE = 10,
	INV_NXDN_MS_VOICE = 11,
	DMR_BS_DATA = 12,
	DMR_BS_VOICE = 13,
	DMR_MS_DATA = 14,
	DMR_MS_VOICE = 15,
	PROVOICE = 16,
	INV_PROVOICE = 17,
	NXDN_BS_DATA = 18,
	INV_NXDN_BS_DATA = 19,
	NXDN_BS_VOICE = 20,
	INV_NXDN_BS_VOICE = 21,
	DSTAR_HD = 22,
	INV_DSTAR_HD = 23,
	DMR_DM_TS1_DATA = 24,
	DMR_DM_TS1_VOICE = 25,
	DMR_DM_TS2_DATA = 26,
	DMR_DM_TS2_VOICE = 27,
}

export interface SyncPattern {
	pattern: string;
	type: SyncType;
	len: number;
}
