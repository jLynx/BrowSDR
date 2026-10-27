/**
 * FLEX Frame Information Word (FIW) decode. A faithful port of the osmocom
 * src/flex/dsp.c flex_rx_decode_fiw routine.
 *
 * The FIW is a single 32-bit BCH(31,21)+parity codeword transmitted at 1600
 * baud / 2FSK immediately after S1. Its 21-bit info field carries the cycle
 * and frame numbers that place this frame in the FLEX time structure, plus the
 * multiple-transmission and roaming parameters.
 */

import { bchDecode } from './bch';
import type { FlexFiw } from './types';

// FIW field layout within the 21-bit info word (frame.h FLEX_FIW_*).
const FIW_CHECKSUM_MASK = 0x0f;
const FIW_CHECKSUM_OK = 0x0f;
const FIW_CYCLE_SHIFT = 4;
const FIW_CYCLE_MASK = 0x0f;
const FIW_FRAME_SHIFT = 8;
const FIW_FRAME_MASK = 0x7f;
const FIW_ROAMING_SHIFT = 15;
const FIW_REPEAT_SHIFT = 16;
const FIW_TRAFFIC_SHIFT = 17;
const FIW_TRAFFIC_MASK = 0x0f;

/**
 * Decode a 32-bit FIW codeword (LSB-first accumulated: bits 0-20 info, 21-30
 * ECC, 31 parity). Returns the decoded FIW, or null if BCH decode or the
 * nibble checksum fails. Mirrors osmocom flex_rx_decode_fiw.
 */
export function decodeFiw(fiwRaw: number): FlexFiw | null {
	const r = bchDecode(fiwRaw >>> 0);
	if (r.info < 0) return null; // uncorrectable
	const data = r.info >>> 0;

	// Checksum: sum of all 4-bit nibbles + bit 20, masked to 4 bits, == 0xF.
	let checksum = data & FIW_CHECKSUM_MASK;
	checksum += (data >>> 4) & 0x0f;
	checksum += (data >>> 8) & 0x0f;
	checksum += (data >>> 12) & 0x0f;
	checksum += (data >>> 16) & 0x0f;
	checksum += (data >>> 20) & 0x01;
	checksum &= FIW_CHECKSUM_MASK;
	if (checksum !== FIW_CHECKSUM_OK) return null;

	const cycle = (data >>> FIW_CYCLE_SHIFT) & FIW_CYCLE_MASK;
	const frame = (data >>> FIW_FRAME_SHIFT) & FIW_FRAME_MASK;
	const roaming = (data >>> FIW_ROAMING_SHIFT) & 0x01;
	const repeat = (data >>> FIW_REPEAT_SHIFT) & 0x01;
	const traffic = (data >>> FIW_TRAFFIC_SHIFT) & FIW_TRAFFIC_MASK;

	let numTransmissions = 1;
	let tdCollapse = -1;
	if (repeat) {
		// r=1: [t1,t0] = tx count, [t3,t2] = TD collapse override.
		const t10 = traffic & 0x03;
		const t32 = (traffic >>> 2) & 0x03;
		if (t10 === 0x01) numTransmissions = 2;
		else if (t10 === 0x02) numTransmissions = 3;
		else if (t10 === 0x03) numTransmissions = 4;
		else numTransmissions = 1; // 00 reserved

		if (t32 === 0x01) tdCollapse = 6;
		else if (t32 === 0x02) tdCollapse = 7;
		else if (t32 === 0x03) tdCollapse = 5;
		else tdCollapse = -1; // 00 use system
	}
	// r=0: transmissions=1, t3-t0 are per-phase low-traffic flags (in traffic).

	return { cycle, frame, roaming, repeat, traffic, numTransmissions, tdCollapse };
}
