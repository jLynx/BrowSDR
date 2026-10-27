/**
 * FLEX temporary-address (group) messaging state tracker.
 *
 * 16 temporary-address slots (0x1F7800..0x1F780F) are assigned to pagers via
 * short-instruction vectors (type 000), then a group message is delivered to
 * the temporary address in a target frame. This reconstructs each slot's state
 * from the wire: idle -> registered (assignment seen) -> delivering (message in
 * the target frame) -> idle (quiet window elapsed). A faithful RX-side view of
 * the osmocom temp-group model (frame.h FLEX_TEMP_ADDR_*).
 */

import type { GroupEvent, GroupSlot, CapClass } from './frame.types';

export const TEMP_ADDR_SLOTS = 16;
export const TEMP_ADDR_SLOT_MASK = 0x0f;
const FLEX_FRAME_WINDOW = 128; // frames in 1 Cycle (ARIB STD-43A sec. 3.1.1 / 5.6)
const FLEX_PHASES_PER_FRAME = 4; // A/B/C/D @ 6400 bps
const FLEX_WORDS_PER_ENROLL = 2; // 1 Address Word + 1 Vector Word (sec. 3.4.1)
const FLEX_ENROLL_PER_PHASE = Math.floor((88 - 1) / FLEX_WORDS_PER_ENROLL); // (PHASE_WORDS-1)/2 = 43
// Physical worst-case group membership permitted by the FLEX protocol:
// 128 frames x 4 phases x 43 enrollments/phase = 22016 (sec. 5.7)
const GROUP_MAX_MEMBERS = FLEX_FRAME_WINDOW * FLEX_PHASES_PER_FRAME * FLEX_ENROLL_PER_PHASE;
// Assignment persistence (osmocom): a registered slot awaiting delivery is
// held up to 128 frames, then released even if no delivery was seen. Frame
// numbers roll over 0-127 within a cycle and cycles roll 0-14, so the age is
// computed on the absolute frame (cycle*128+frame) modulo 1920.
const GROUP_REGISTERED_FRAMES = 128;
// After a delivery the transaction is complete; hold the 'delivering' state a
// short window so the user sees it, then release the slot to idle.
const GROUP_DELIVERED_FRAMES = 8;
const FRAME_MODULO = 1920; // 15 cycles x 128 frames

// Address/vector constants needed to detect group events (frame.h).
const SHORT_ADDR_OFFSET = 32768;
const TEMPORARY_MIN = 0x1f7800;
const VEC_TYPE_SHIFT = 4;
const VEC_TYPE_MASK = 0x07;
const VEC_SHORT_INSTR = 0x1;
const VEC_INSTR_SHIFT = 7;
const VEC_INSTR_MASK = 0x3fff;
const INSTR_TYPE_MASK = 0x07;
const INSTR_TYPE_TEMP_ADDR = 0x00;
const INSTR_FRAME_SHIFT = 3;
const INSTR_FRAME_MASK = 0x7f;
const INSTR_SLOT_SHIFT = 10;
const INSTR_SLOT_MASK = 0x0f;

/**
 * Detect a group event from a vector word: a temporary-address message is a
 * delivery; a short-instruction type-000 vector is a member assignment (target
 * frame + slot). Appends to `out` when a group event is present.
 */
export function recordGroupEvent(viw: number, capClass: CapClass, capcode: number, out: GroupEvent[]): void {
	if (capClass === 'temporary') {
		out.push({ kind: 'deliver', slot: tempSlotOf(capcode) });
		return;
	}
	if (((viw >> VEC_TYPE_SHIFT) & VEC_TYPE_MASK) === VEC_SHORT_INSTR) {
		const data = (viw >> VEC_INSTR_SHIFT) & VEC_INSTR_MASK;
		if ((data & INSTR_TYPE_MASK) === INSTR_TYPE_TEMP_ADDR) {
			out.push({
				kind: 'assign',
				slot: (data >> INSTR_SLOT_SHIFT) & INSTR_SLOT_MASK,
				targetFrame: (data >> INSTR_FRAME_SHIFT) & INSTR_FRAME_MASK,
				capcode,
			});
		}
	}
}

/** Fresh set of 16 idle group slots. */
export function makeGroupSlots(): GroupSlot[] {
	return Array.from({ length: TEMP_ADDR_SLOTS }, () => ({ state: 'idle' as const, targetFrame: -1, members: [], lastFrameAbs: 0 }));
}

// System-event flag labels (short-instruction type 001, e0-e10; frame.h).
const SYS_EVENT_FLAGS = ['SSID-TMF-split', 'NID-TMF-split', 'channel-setup-change', 'new-NID-freq', 'new-SSID-freq'];

/**
 * Human-readable description of a short-instruction vector for display:
 * type 000 = temp-group setup (slot + target frame), type 001 = system event
 * (named flags). Returns '' for an unrecognized instruction.
 */
export function describeInstruction(viw: number): string {
	if (((viw >> VEC_TYPE_SHIFT) & VEC_TYPE_MASK) !== VEC_SHORT_INSTR) return '';
	const data = (viw >> VEC_INSTR_SHIFT) & VEC_INSTR_MASK;
	const type = data & INSTR_TYPE_MASK;
	if (type === INSTR_TYPE_TEMP_ADDR) {
		const slot = (data >> INSTR_SLOT_SHIFT) & INSTR_SLOT_MASK;
		const frame = (data >> INSTR_FRAME_SHIFT) & INSTR_FRAME_MASK;
		return `group setup: slot ${slot}, deliver in frame ${frame}`;
	}
	if (type === 0x1) {
		// System event: 11-bit flags at bits 3-13 of the instruction data.
		const flags = (data >> 3) & 0x7ff;
		const names = SYS_EVENT_FLAGS.filter((_, b) => (flags >> b) & 1);
		return `system event${names.length ? ': ' + names.join(', ') : ''}`;
	}
	return 'instruction (reserved)';
}

/** The temp-address slot index (0-15) for a temporary-address capcode. */
export function tempSlotOf(capcode: number): number {
	return (capcode + SHORT_ADDR_OFFSET - TEMPORARY_MIN) & TEMP_ADDR_SLOT_MASK;
}

/** Apply a frame's group events to a polarity's slot state. */
export function foldGroupEvents(slots: GroupSlot[], frameAbs: number, events: GroupEvent[]): void {
	for (const ev of events) {
		if (ev.slot < 0 || ev.slot >= TEMP_ADDR_SLOTS) continue;
		const s = slots[ev.slot];
		s.lastFrameAbs = frameAbs;
		if (ev.kind === 'assign') {
			s.state = 'registered';
			s.targetFrame = ev.targetFrame;
			if (!s.members.includes(ev.capcode) && s.members.length < GROUP_MAX_MEMBERS) s.members.push(ev.capcode);
		} else {
			s.state = 'delivering';
		}
	}
}

/** Age group slots: release a delivered slot after a short window, and a
 * registered-but-undelivered slot after the 128-frame assignment persistence
 * (both on the rollover-safe absolute frame). */
export function ageGroups(slots: GroupSlot[], frameAbs: number): void {
	for (const s of slots) {
		if (s.state === 'idle') continue;
		const age = (frameAbs - s.lastFrameAbs + FRAME_MODULO) % FRAME_MODULO;
		const limit = s.state === 'delivering' ? GROUP_DELIVERED_FRAMES : GROUP_REGISTERED_FRAMES;
		if (age >= limit) {
			s.state = 'idle';
			s.targetFrame = -1;
			s.members = [];
		}
	}
}
