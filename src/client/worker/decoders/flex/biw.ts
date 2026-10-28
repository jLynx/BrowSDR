/**
 * FLEX Block Information Word (BIW) network/temporal decode.
 *
 * BIW words sit between BIW word 0 and the address field of a frame (indices
 * 1..aoffset-1). Beyond the frame-geometry word 0, they carry the simulcast
 * system identity (SSID1/SSID2), the network date and local time, and the
 * timezone. Field layout per ARIB STD-43A Table 3.7.2-1.
 *
 * SSID1/SSID2 (system identity) are promoted on first sight. DATE / TIME /
 * SysInfo (the over-the-air clock) are noisy -- a corrupt-but-in-range BCH
 * word would otherwise poison the clock -- so they are routed through the
 * consistency voting in flextime.ts and promoted only once corroborated.
 */

import { voteDate, voteTime, voteTz, correctYearRollover } from './flextime';
import type { FlexNetInfo, FlexTimeVote } from './frame.types';
import type { FlexFiw } from './types';

const FLEX_WORDS_PER_FRAME = 88;
// Word status values shared with the frame decoder (frame.h flex_word_status).
const WORD_NOT_RECEIVED = 0;
const WORD_UNCORRECTABLE = 3;

const BIW_TYPE_SHIFT = 4;
const BIW_TYPE_MASK = 0x07;
const BIW_TYPE_SSID1 = 0x00; // local id + coverage zone
const BIW_TYPE_DATE = 0x01; // month/day/year
const BIW_TYPE_TIME = 0x02; // second/minute/hour
const BIW_TYPE_SYSINFO = 0x05; // system info (A=0100/0101 carry TZ)
const BIW_TYPE_SSID2 = 0x07; // country code
// SSID1 (type 000).
const BIW_SSID1_COVERAGE_SHIFT = 7;
const BIW_SSID1_COVERAGE_MASK = 0x1f;
const BIW_SSID1_LOCALID_SHIFT = 12;
const BIW_SSID1_LOCALID_MASK = 0x1ff;
// DATE (type 001): year Y4-Y0 (bits 7-11, base 1994), day (12-16), month (17-20).
const BIW_DATE_YEAR_SHIFT = 7;
const BIW_DATE_YEAR_MASK = 0x1f;
const BIW_DATE_YEAR_BASE = 1994;
const BIW_DATE_DAY_SHIFT = 12;
const BIW_DATE_DAY_MASK = 0x1f;
const BIW_DATE_MONTH_SHIFT = 17;
const BIW_DATE_MONTH_MASK = 0x0f;
// TIME (type 010): hour H4-H0 (7-11), minute M5-M0 (12-17), second S2-S0 (18-20, 7.5s steps).
const BIW_TIME_HOUR_SHIFT = 7;
const BIW_TIME_HOUR_MASK = 0x1f;
const BIW_TIME_MINUTE_SHIFT = 12;
const BIW_TIME_MINUTE_MASK = 0x3f;
const BIW_TIME_SECOND_SHIFT = 18;
const BIW_TIME_SECOND_MASK = 0x07;
// SYSINFO (type 101): A3-A0 (bits 7-10), info I9-I0 (bits 11-20). Time-related
// sub-types A=0100 / 0101 (standard page 37) carry zone Z4-Z0 (info bits 0-4),
// DST L0 (info bit 5, 0=DST active), extended seconds S5-S3 (info bits 7-9).
const BIW_SYSINFO_A_SHIFT = 7;
const BIW_SYSINFO_A_MASK = 0x0f;
const BIW_SYSINFO_A_TIME1 = 0x4;
const BIW_SYSINFO_A_TIME2 = 0x5;
const BIW_SYSINFO_INFO_SHIFT = 11;
const BIW_SYSINFO_INFO_MASK = 0x3ff;
// SSID2 (type 111): country code in bits 11-20, TMF in bits 7-10.
const BIW_SSID2_COUNTRY_SHIFT = 11;
const BIW_SSID2_COUNTRY_MASK = 0x3ff;
const BIW_SSID2_TMF_SHIFT = 7;
const BIW_SSID2_TMF_MASK = 0x0f;
// Timezone offset in minutes by 5-bit zone code (ARIB Table 3.7.2-3).
const FLEX_TZ_TABLE = [
	0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 210, 270, 330, 0, 345, 390, 570, -210, -660, -600, -540, -480, -420, -360,
	-300, -240, -180, -120, -60,
];

function wordLost(status: number): boolean {
	return status === WORD_UNCORRECTABLE || status === WORD_NOT_RECEIVED;
}

/**
 * Parse the BIW words (indices 1..aoffset-1). SSID1/SSID2 identity promotes
 * immediately; DATE/TIME/SysInfo clock readings are voted (via `vote`) and
 * promote into `net` only when corroborated. `fiw` supplies the cycle/frame
 * ground truth the time/esec cross-checks need.
 */
export function decodeBiws(
	words: Uint32Array,
	status: Int8Array,
	aoffset: number,
	net: FlexNetInfo,
	fiw: FlexFiw,
	vote: FlexTimeVote,
	frameMono: number,
): void {
	for (let i = 1; i < aoffset && i < FLEX_WORDS_PER_FRAME; i++) {
		if (wordLost(status[i])) continue;
		const dw = words[i];
		switch ((dw >> BIW_TYPE_SHIFT) & BIW_TYPE_MASK) {
			case BIW_TYPE_SSID1:
				net.coverageZone = (dw >> BIW_SSID1_COVERAGE_SHIFT) & BIW_SSID1_COVERAGE_MASK;
				net.localId = (dw >> BIW_SSID1_LOCALID_SHIFT) & BIW_SSID1_LOCALID_MASK;
				break;
			case BIW_TYPE_SSID2:
				net.countryCode = (dw >> BIW_SSID2_COUNTRY_SHIFT) & BIW_SSID2_COUNTRY_MASK;
				net.tmf = (dw >> BIW_SSID2_TMF_SHIFT) & BIW_SSID2_TMF_MASK;
				break;
			case BIW_TYPE_DATE:
				voteDateWord(dw, net, vote, frameMono);
				break;
			case BIW_TYPE_TIME:
				voteTimeWord(dw, net, vote, fiw, frameMono);
				break;
			case BIW_TYPE_SYSINFO:
				voteSysInfoWord(dw, net, vote, fiw, frameMono);
				break;
		}
	}
}

/** Extract a DATE word (with year rollover correction) and vote it. */
function voteDateWord(dw: number, net: FlexNetInfo, vote: FlexTimeVote, frameMono: number): void {
	const yearRaw = (dw >> BIW_DATE_YEAR_SHIFT) & BIW_DATE_YEAR_MASK;
	const day = (dw >> BIW_DATE_DAY_SHIFT) & BIW_DATE_DAY_MASK;
	const month = (dw >> BIW_DATE_MONTH_SHIFT) & BIW_DATE_MONTH_MASK;
	if (month < 1 || month > 12 || day < 1 || day > 31) return;
	voteDate(vote, net, correctYearRollover(BIW_DATE_YEAR_BASE + yearRaw), month, day, frameMono);
}

/** Extract a TIME word and vote it (with FIW minute cross-check). */
function voteTimeWord(dw: number, net: FlexNetInfo, vote: FlexTimeVote, fiw: FlexFiw, frameMono: number): void {
	const hour = (dw >> BIW_TIME_HOUR_SHIFT) & BIW_TIME_HOUR_MASK;
	const minute = (dw >> BIW_TIME_MINUTE_SHIFT) & BIW_TIME_MINUTE_MASK;
	const sec = (dw >> BIW_TIME_SECOND_SHIFT) & BIW_TIME_SECOND_MASK;
	if (hour > 23 || minute > 59 || sec > 7) return;
	voteTime(vote, net, hour, minute, sec, fiw.cycle, fiw.frame, frameMono);
}

/** Extract a SysInfo word; if it is a time sub-type (A=0100/0101), vote the TZ. */
function voteSysInfoWord(dw: number, net: FlexNetInfo, vote: FlexTimeVote, fiw: FlexFiw, frameMono: number): void {
	const a = (dw >> BIW_SYSINFO_A_SHIFT) & BIW_SYSINFO_A_MASK;
	if (a !== BIW_SYSINFO_A_TIME1 && a !== BIW_SYSINFO_A_TIME2) return;
	const info = (dw >> BIW_SYSINFO_INFO_SHIFT) & BIW_SYSINFO_INFO_MASK;
	const zone = info & 0x1f;
	const dst = ((info >> 5) & 1) === 0; // L0=0 => DST active
	const esec = (info >> 7) & 0x7;
	voteTz(vote, net, zone, dst, esec, FLEX_TZ_TABLE[zone] ?? 0, fiw.cycle, fiw.frame, frameMono);
}
