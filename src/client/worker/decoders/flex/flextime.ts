/**
 * FLEX over-the-air clock consistency voting (ARIB STD-43A 3.7.2; faithful
 * port of multimon-ng flextime_vote_*). A single BIW date/time/timezone word
 * that passes BCH can still be wrong -- a corrupted word yields a random but
 * in-range value. So readings are not trusted on first sight: each component
 * is promoted only after FLEX_VOTE_THRESHOLD of the last FLEX_VOTE_RING
 * readings agree.
 *
 *   - Time: validated against the FIW-derived minute (independent ground
 *     truth from cycle/frame), then must tick forward (midnight wrap allowed),
 *     then confirmed after THRESHOLD consecutive valid readings.
 *   - Date: must be a valid calendar date, then THRESHOLD of the ring must
 *     agree (same day or an adjacent-day rollover). Year carries the 32-year
 *     rollover correction (the 5-bit field wraps after 2025).
 *   - Timezone: zone + DST + extended-seconds identical across THRESHOLD ring
 *     entries, with the esec cross-checked against the FIW frame position.
 *
 * Standard note: the time-related SysInfo sub-types are A3A2A1A0 = 0100 and
 * 0101 (page 37, Table 3.7.2). multimon-ng tests 4 || 8, which is a bug in the
 * reference; the standard (and this port) uses 4 || 5.
 */

import type { FlexNetInfo, FlexTimeVote } from './frame.types';

const VOTE_THRESHOLD = 3;
const VOTE_RING = 8;
const TIME_CROSS_SPAN = 3; // BIW minute must fall in the cycle's [cycle*4 .. +3] window
const ESEC_TOLERANCE = 1; // extended-seconds vs FIW-derived window
// Expire a confirmed clock component that has not been refreshed for a full
// frame cycle (15 cycles x 128 frames = 1920 frames, ~1 hour). Measured on a
// MONOTONIC frame counter so a stale age cannot wrap and alias a fresh one.
// (multimon-ng's flextime_expire uses 1925 against a mod-1920 age, so its
// threshold can never be reached -- a dead no-op; this does it correctly.)
const EXPIRE_FRAMES = 1920;

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Build empty network/temporal info (BIW identity + voted clock). */
export function makeNetInfo(): FlexNetInfo {
	return {
		localId: null,
		coverageZone: null,
		countryCode: null,
		tmf: null,
		date: null,
		time: null,
		tzOffsetMin: null,
		dst: null,
		clock: null,
	};
}

/** Build empty flextime vote state. */
export function makeFlexTimeVote(): FlexTimeVote {
	return {
		timeCount: 0,
		timeHour: 0,
		timeMin: 0,
		timeSec: 0,
		tmode: 0,
		tmodeVotesStd: 0,
		tmodeVotesDir: 0,
		tmodeAnchorValid: false,
		tmodeAnchorCycle: -1,
		tmodeAnchorFrame: 0,
		tmodeAnchorMin: 0,
		tmodeAnchorSec: 0,
		extSec: -1,
		dateRing: [],
		dateIdx: 0,
		tzRing: [],
		tzIdx: 0,
		confirmedDate: -1,
		confirmedTime: -1,
		confirmedTz: -1,
		monoBase: 0,
		lastAbs: -1,
	};
}

const FRAME_SPACE = 1920; // one full frame cycle (15 x 128)

/**
 * Advance the monotonic frame counter and expire stale clock components. Call
 * once per decoded frame with the mod-1920 FIW frame; returns the monotonic
 * frame to pass to the vote functions. A frame that does not increase marks a
 * cycle-space wrap, so one full cycle is added to the base.
 */
export function tickFlexTime(v: FlexTimeVote, net: FlexNetInfo, frameAbs: number): number {
	if (v.lastAbs >= 0 && frameAbs <= v.lastAbs) v.monoBase += FRAME_SPACE;
	v.lastAbs = frameAbs;
	const frameMono = v.monoBase + frameAbs;
	expireFlexTime(v, net, frameMono);
	return frameMono;
}

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

function isLeap(y: number): boolean {
	return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
	return m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m];
}

/** Valid calendar date (rejects Feb 30, Apr 31, ...). */
export function dateValid(year: number, month: number, day: number): boolean {
	if (month < 1 || month > 12 || day < 1) return false;
	return day <= daysInMonth(year, month);
}

/** The calendar day after (y,m,d), handling month/year rollover. */
function nextDay(y: number, m: number, d: number): [number, number, number] {
	if (d < daysInMonth(y, m)) return [y, m, d + 1];
	if (m < 12) return [y, m + 1, 1];
	return [y + 1, 1, 1];
}

/** Two dates agree if identical or adjacent calendar days (midnight rollover). */
function datesAgree(y1: number, m1: number, d1: number, y2: number, m2: number, d2: number): boolean {
	if (y1 === y2 && m1 === m2 && d1 === d2) return true;
	const [ay, am, ad] = nextDay(y1, m1, d1);
	if (ay === y2 && am === m2 && ad === d2) return true;
	const [by, bm, bd] = nextDay(y2, m2, d2);
	return by === y1 && bm === m1 && bd === d1;
}

/**
 * Correct the 5-bit FLEX year field's epoch. The field (0-31) is an offset from
 * base 1994, so it natively spans 1994-2025 and then wraps: raw 0 means 2026
 * (not 1994), raw 1 means 2027, and so on. The absolute year is presumed from
 * the local system year -- roll the decoded year forward by whole 32-year epochs
 * until it lands within ~16 years of now. `year` is the raw field already added
 * to the 1994 base.
 */
export function correctYearRollover(year: number): number {
	const curYear = new Date().getFullYear(); // local year presumption of "now"
	let y = year;
	while (y + 16 < curYear) y += 32;
	return y;
}

/** Cross-validate a BIW minute against the FIW-derived cycle window: the BIW
 * minute must fall in [cycle*4 .. cycle*4+3] mod 60 (covers standard + direct
 * time conventions). */
function fiwMinuteOk(biwMin: number, cycle: number): boolean {
	const base = (cycle * 4) % 60;
	let diff = biwMin - base;
	if (diff < -30) diff += 60;
	if (diff > 30) diff -= 60;
	return diff >= 0 && diff <= TIME_CROSS_SPAN;
}

function hhmmToMin(h: number, m: number): number {
	return h * 60 + m;
}

/**
 * Vote a TIME reading. Returns true when promoted (confirmed) -- the caller
 * then writes the confirmed time into FlexNetInfo. Rejects readings failing
 * the FIW cross-check (resets the streak); resets on a non-wrap backward jump.
 */
export function voteTime(
	v: FlexTimeVote,
	net: FlexNetInfo,
	hour: number,
	min: number,
	sec: number,
	cycle: number,
	frame: number,
	frameMono: number,
): boolean {
	if (!fiwMinuteOk(min, cycle)) {
		v.timeCount = 0;
		return false;
	}
	if (v.timeCount > 0) {
		let delta = hhmmToMin(hour, min) - hhmmToMin(v.timeHour, v.timeMin);
		if (delta < -720) delta += 1440; // midnight wrap counts as forward
		if (delta < 0) v.timeCount = 0; // backward -> reset, start a fresh streak
	}
	v.timeHour = hour;
	v.timeMin = min;
	v.timeSec = sec;
	v.timeCount++;
	detectTimeMode(v, min, sec, cycle, frame);
	if (v.timeCount >= VOTE_THRESHOLD) {
		const coarse = Math.round(sec * 7.5);
		net.time = `${pad2(hour)}:${pad2(min)}:${pad2(coarse)}`;
		v.confirmedTime = frameMono;
		updateClock(v, net);
		return true;
	}
	return false;
}

/**
 * Detect STANDARD vs DIRECT time mode (ARIB 3.7.2; port of multimon-ng). Within
 * one cycle, compare this TIME reading against an anchor >=5 frames earlier:
 * identical min/sec means the time is held constant across the cycle (STANDARD,
 * Frame-0 time), differing means it tracks the frame (DIRECT). Three agreeing
 * votes flip the mode. A new cycle (re)sets the anchor.
 */
function detectTimeMode(v: FlexTimeVote, min: number, sec: number, cycle: number, frame: number): void {
	if (v.tmodeAnchorValid && v.tmodeAnchorCycle === cycle) {
		if (Math.abs(frame - v.tmodeAnchorFrame) >= 5) {
			const same = min === v.tmodeAnchorMin && sec === v.tmodeAnchorSec;
			if (same) {
				v.tmodeVotesStd++;
				v.tmodeVotesDir = 0;
			} else {
				v.tmodeVotesDir++;
				v.tmodeVotesStd = 0;
			}
			if (v.tmodeVotesStd >= VOTE_THRESHOLD) v.tmode = 0;
			if (v.tmodeVotesDir >= VOTE_THRESHOLD) v.tmode = 1;
			v.tmodeAnchorMin = min;
			v.tmodeAnchorSec = sec;
			v.tmodeAnchorFrame = frame;
		}
	} else {
		v.tmodeAnchorMin = min;
		v.tmodeAnchorSec = sec;
		v.tmodeAnchorFrame = frame;
		v.tmodeAnchorCycle = cycle;
		v.tmodeAnchorValid = true;
	}
}

/** Refresh net.clock from the confirmed time vote (+ TZ extSec if confirmed). */
function updateClock(v: FlexTimeVote, net: FlexNetInfo): void {
	const prev = net.clock;
	net.clock = {
		year: prev?.year ?? null,
		month: prev?.month ?? null,
		day: prev?.day ?? null,
		hour: v.timeHour,
		min: v.timeMin,
		coarseSec: v.timeSec,
		extSec: v.extSec >= 0 ? v.extSec : null,
		standardMode: v.tmode === 0,
	};
}

/**
 * Vote a DATE reading (year already rollover-corrected). Returns true when
 * promoted. Pushes every calendar-valid reading into the ring, then promotes
 * when THRESHOLD ring entries agree (same or adjacent day).
 */
export function voteDate(v: FlexTimeVote, net: FlexNetInfo, year: number, month: number, day: number, frameMono: number): boolean {
	if (!dateValid(year, month, day)) return false;
	const entry = { year, month, day };
	if (v.dateRing.length < VOTE_RING) v.dateRing.push(entry);
	else v.dateRing[v.dateIdx] = entry;
	v.dateIdx = (v.dateIdx + 1) % VOTE_RING;

	let agree = 0;
	for (const e of v.dateRing) if (datesAgree(year, month, day, e.year, e.month, e.day)) agree++;
	if (agree >= VOTE_THRESHOLD) {
		net.date = `${year}-${pad2(month)}-${pad2(day)}`;
		v.confirmedDate = frameMono;
		if (net.clock) {
			net.clock.year = year;
			net.clock.month = month;
			net.clock.day = day;
		}
		return true;
	}
	return false;
}

/**
 * Vote a TIMEZONE reading. `esec` is gated against the FIW-derived window
 * before entering the ring; zone + DST + esec must match THRESHOLD entries to
 * promote. Returns true when promoted. `tzOffsetMin` is the looked-up offset.
 */
export function voteTz(
	v: FlexTimeVote,
	net: FlexNetInfo,
	zone: number,
	dst: boolean,
	esec: number,
	tzOffsetMin: number,
	cycle: number,
	frame: number,
	frameMono: number,
): boolean {
	const expectedExt = (((cycle * 128 + frame) % 32) / 4) | 0;
	let diff = esec - expectedExt;
	if (diff > 4) diff -= 8;
	if (diff < -4) diff += 8;
	if (Math.abs(diff) > ESEC_TOLERANCE) return false; // corrupt esec, don't pollute the ring

	const entry = { zone, dst, esec };
	if (v.tzRing.length < VOTE_RING) v.tzRing.push(entry);
	else v.tzRing[v.tzIdx] = entry;
	v.tzIdx = (v.tzIdx + 1) % VOTE_RING;

	let agree = 0;
	for (const e of v.tzRing) if (e.zone === zone && e.dst === dst && e.esec === esec) agree++;
	if (agree >= VOTE_THRESHOLD) {
		net.tzOffsetMin = tzOffsetMin;
		net.dst = dst;
		v.confirmedTz = frameMono;
		v.extSec = esec;
		if (net.clock) net.clock.extSec = esec;
		return true;
	}
	return false;
}

/**
 * Expire confirmed clock components that have gone a full frame cycle without
 * a fresh confirmation (signal lost / tuned away), so a stale timestamp is not
 * shown forever. `frameMono` is the monotonic absolute-frame counter (NOT the
 * mod-1920 FIW frame), so elapsed time is measured correctly across cycle
 * wraps. On expiry the component is cleared from `net` and its vote state reset
 * so a reappearance must re-confirm from scratch. Call once per decoded frame.
 */
function expireFlexTime(v: FlexTimeVote, net: FlexNetInfo, frameMono: number): void {
	if (v.confirmedDate >= 0 && frameMono - v.confirmedDate >= EXPIRE_FRAMES) {
		net.date = null;
		v.confirmedDate = -1;
		v.dateRing = [];
		v.dateIdx = 0;
		if (net.clock) {
			net.clock.year = null;
			net.clock.month = null;
			net.clock.day = null;
		}
	}
	if (v.confirmedTime >= 0 && frameMono - v.confirmedTime >= EXPIRE_FRAMES) {
		net.time = null;
		v.confirmedTime = -1;
		v.timeCount = 0;
		net.clock = null; // time is the clock's anchor; drop the whole struct
	}
	if (v.confirmedTz >= 0 && frameMono - v.confirmedTz >= EXPIRE_FRAMES) {
		net.tzOffsetMin = null;
		net.dst = null;
		v.confirmedTz = -1;
		v.tzRing = [];
		v.tzIdx = 0;
		v.extSec = -1;
		if (net.clock) net.clock.extSec = null;
	}
}

/**
 * Build the calculated over-the-air timestamp from the confirmed network clock
 * (ARIB 3.7.2), matching multimon-ng's OTA format:
 *   "<YYYY-MM-DD> <HH:MM:SS.ss> <+Nh[MMm]>[ DST]"
 *
 * Seconds are computed per the detected time mode and the current frame:
 *   base = min*60 + coarseSec*7.5
 *        + extSec*0.9375   (when TZ/extended-seconds is confirmed)
 *        + frame*1.875     (STANDARD mode only: TIME is the cycle's Frame-0
 *                           time held constant, so the frame offset recovers
 *                           this frame's instant; DIRECT mode already carries
 *                           the exact per-frame time, so no offset is added)
 * then normalized with carry into minute/hour. `frame` is the current FIW frame
 * (0-127). Each component appears only when confirmed; the offset renders as
 * whole hours ("+2h") or hours+minutes ("+5h30m") with a trailing " DST" when
 * daylight saving is active. Returns null when no component is available.
 */
/** Format just the time component (HH:MM:SS) for the current frame,
 * extrapolating from the confirmed TIME vote in standard mode.
 * Returns null when no confirmed clock is available. */
export function formatFlexTimeOnly(net: FlexNetInfo, frame: number): string | null {
	const c = net.clock;
	if (!c) return net.time;
	let baseSec = c.min * 60 + c.coarseSec * 7.5;
	if (c.extSec !== null) baseSec += c.extSec * 0.9375;
	if (c.standardMode) baseSec += frame * 1.875;
	let outMin = Math.floor(baseSec / 60);
	const outSec = baseSec - outMin * 60;
	let outHour = c.hour;
	if (outMin >= 60) {
		outMin -= 60;
		outHour = (outHour + 1) % 24;
	}
	return `${pad2(outHour)}:${pad2(outMin)}:${pad2(Math.trunc(outSec))}`;
}

export function formatFlexTime(net: FlexNetInfo, frame: number): string | null {
	const parts: string[] = [];
	if (net.date) parts.push(net.date);
	const c = net.clock;
	if (c) {
		let baseSec = c.min * 60 + c.coarseSec * 7.5;
		if (c.extSec !== null) baseSec += c.extSec * 0.9375;
		if (c.standardMode) baseSec += frame * 1.875;
		let outMin = Math.floor(baseSec / 60);
		const outSec = baseSec - outMin * 60;
		let outHour = c.hour;
		if (outMin >= 60) {
			outMin -= 60;
			outHour = (outHour + 1) % 24;
		}
		parts.push(`${pad2(outHour)}:${pad2(outMin)}:${pad2(Math.trunc(outSec))}`);
	}
	if (net.tzOffsetMin !== null && net.tzOffsetMin !== undefined) {
		const off = net.tzOffsetMin;
		const absOff = Math.abs(off);
		const sign = off < 0 ? '-' : '+';
		const h = Math.trunc(absOff / 60);
		const m = absOff % 60;
		let tz = m === 0 ? `${sign}${h}h` : `${sign}${h}h${pad2(m)}m`;
		if (net.dst) tz += ' DST';
		parts.push(tz);
	}
	return parts.length ? parts.join(' ') : null;
}
