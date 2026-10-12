/*
 * DSD symbol constants and interleave tables, ported from SDR++ Brown.
 * Original DSD source: https://github.com/szechyjs/dsd
 * Copyright (C) 2010 DSD Author (ISC License)
 */

export const SYNC_WORDS = {
	// P25 Phase 1
	P25P1: '111113113311333313133333',
	INV_P25P1: '333331331133111131311111',

	// DMR Base Station
	DMR_BS_DATA: '313333111331131131331131',
	DMR_BS_VOICE: '131111333113313313113313',
	// DMR Mobile Station
	DMR_MS_DATA: '311131133313133331131113',
	DMR_MS_VOICE: '133313311131311113313331',
	// DMR Direct Mode
	DMR_DM_TS1_DATA: '331333313111313133311111',
	DMR_DM_TS1_VOICE: '113111131333131311133333',
	DMR_DM_TS2_DATA: '311311111333113333133311',
	DMR_DM_TS2_VOICE: '133133333111331111311133',

	// D-STAR
	DSTAR_HD: '131313131333133113131111',
	INV_DSTAR_HD: '313131313111311331313333',
	DSTAR: '313131313133131113313111',
	INV_DSTAR: '131313131311313331131333',

	// NXDN
	NXDN_MS_DATA: '313133113131111333',
	INV_NXDN_MS_DATA: '131311331313333111',
	NXDN_MS_VOICE: '313133113131113133',
	INV_NXDN_MS_VOICE: '131311331313331311',
	NXDN_BS_DATA: '313133113131111313',
	INV_NXDN_BS_DATA: '131311331313333131',
	NXDN_BS_VOICE: '313133113131113113',
	INV_NXDN_BS_VOICE: '131311331313331331',
} as const;

export const SYNC_LEN_24 = 24;

export const SYNC_LEN_18 = 18;

export const DSD_SYMBOL_RATE = 4800;

export const DSD_IF_RATE = 48000;

export const DSD_AUDIO_RATE = 8000;

export const MBE_SAMPLES_PER_FRAME = 160;

export const SLICER_MID_FACTOR = 0.6;

export const SLICER_MAX_CLAMP = 1.3;

export const SLICER_MIN_CLAMP = -1.3;

export const SLICER_LVL_BUF_SIZE = 1024;

export const MBE_UV_QUALITY = 3;

export const DMR_W = new Int8Array([
	0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2,
]);

export const DMR_X = new Int8Array([
	23, 10, 22, 9, 21, 8, 20, 7, 19, 6, 18, 5, 17, 4, 16, 3, 15, 2, 14, 1, 13, 0, 12, 10, 11, 9, 10, 8, 9, 7, 8, 6, 7, 5, 6, 4,
]);

export const DMR_Y = new Int8Array([
	0, 2, 0, 2, 0, 2, 0, 2, 0, 3, 0, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3,
]);

export const DMR_Z = new Int8Array([
	5, 3, 4, 2, 3, 1, 2, 0, 1, 13, 0, 12, 22, 11, 21, 10, 20, 9, 19, 8, 18, 7, 17, 6, 16, 5, 15, 4, 14, 3, 13, 2, 12, 1, 11, 0,
]);

export const P25_IW = new Int8Array([
	0, 2, 4, 1, 3, 5, 0, 2, 4, 1, 3, 6, 0, 2, 4, 1, 3, 6, 0, 2, 4, 1, 3, 6, 0, 2, 4, 1, 3, 6, 0, 2, 4, 1, 3, 6, 0, 2, 5, 1, 3, 6, 0, 2, 5, 1,
	3, 6, 0, 2, 5, 1, 3, 7, 0, 2, 5, 1, 3, 7, 0, 2, 5, 1, 4, 7, 0, 3, 5, 2, 4, 7,
]);

export const P25_IX = new Int8Array([
	22, 20, 10, 20, 18, 0, 20, 18, 8, 18, 16, 13, 18, 16, 6, 16, 14, 11, 16, 14, 4, 14, 12, 9, 14, 12, 2, 12, 10, 7, 12, 10, 0, 10, 8, 5, 10,
	8, 13, 8, 6, 3, 8, 6, 11, 6, 4, 1, 6, 4, 9, 4, 2, 6, 4, 2, 7, 2, 0, 4, 2, 0, 5, 0, 13, 2, 0, 21, 3, 21, 11, 0,
]);

export const P25_IY = new Int8Array([
	1, 3, 5, 0, 2, 4, 1, 3, 6, 0, 2, 4, 1, 3, 6, 0, 2, 4, 1, 3, 6, 0, 2, 4, 1, 3, 6, 0, 2, 4, 1, 3, 6, 0, 2, 5, 1, 3, 6, 0, 2, 5, 1, 3, 6, 0,
	2, 5, 1, 3, 6, 0, 2, 5, 1, 3, 7, 0, 2, 5, 1, 4, 7, 0, 3, 5, 2, 4, 7, 1, 3, 5,
]);

export const P25_IZ = new Int8Array([
	21, 19, 1, 21, 19, 9, 19, 17, 14, 19, 17, 7, 17, 15, 12, 17, 15, 5, 15, 13, 10, 15, 13, 3, 13, 11, 8, 13, 11, 1, 11, 9, 6, 11, 9, 14, 9,
	7, 4, 9, 7, 12, 7, 5, 2, 7, 5, 10, 5, 3, 0, 5, 3, 8, 3, 1, 5, 3, 1, 6, 1, 14, 3, 1, 22, 4, 22, 12, 1, 22, 20, 2,
]);

export const DSTAR_W = new Int8Array([
	0, 0, 3, 2, 1, 1, 0, 0, 1, 1, 0, 0, 3, 2, 1, 1, 3, 2, 1, 1, 0, 0, 3, 2, 0, 0, 3, 2, 1, 1, 0, 0, 1, 1, 0, 0, 3, 2, 1, 1, 3, 2, 1, 1, 0, 0,
	3, 2, 0, 0, 3, 2, 1, 1, 0, 0, 1, 1, 0, 0, 3, 2, 1, 1, 3, 3, 2, 1, 0, 0, 3, 3,
]);

export const DSTAR_X = new Int8Array([
	10, 22, 11, 9, 10, 22, 11, 23, 8, 20, 9, 21, 10, 8, 9, 21, 8, 6, 7, 19, 8, 20, 9, 7, 6, 18, 7, 5, 6, 18, 7, 19, 4, 16, 5, 17, 6, 4, 5, 17,
	4, 2, 3, 15, 4, 16, 5, 3, 2, 14, 3, 1, 2, 14, 3, 15, 0, 12, 1, 13, 2, 0, 1, 13, 0, 12, 10, 11, 0, 12, 1, 13,
]);

export const NXDN_W = DMR_W;

export const NXDN_X = DMR_X;

export const NXDN_Y = DMR_Y;

export const NXDN_Z = DMR_Z;

export const NXDN_PR = new Uint8Array([
	1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0,
	1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
	0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1,
	1, 1, 0, 0, 0, 1,
]);

export const RRC_ALPHA = 0.2;

export const RRC_NUM_TAPS = 65;
