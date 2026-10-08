/*
 * D-STAR frame processor for DSD.
 * Ported from SDR++ Brown dsd_dstar.cpp.
 *
 * D-STAR uses AMBE 3600x2400 and a 72-element interleave schedule.
 * The current WASM wrapper only exposes 2450 decoding, so correcting this
 * matrix alone does not provide complete D-STAR voice support.
 */

import { DSTAR_W, DSTAR_X } from './constants';
import type { DSDStatus } from './types';

// ── D-STAR voice frame processing ────────────────────────────────────

/**
 * Map 72 D-STAR GMSK symbols into one 4x24 AMBE matrix.
 * Unlike DMR, each symbol carries one bit. The shared four-level slicer's
 * high bit is the symbol polarity (0 for positive, 1 for negative).
 * DSD's dstar.c digitizer uses this polarity bit and the full dW/dX schedule:
 * https://github.com/szechyjs/dsd/blob/master/src/dstar.c
 * No Y/Z schedule or second AMBE frame is used by D-STAR.
 */
export function processDSTARVoice(dibitBuf: Uint8Array, dibitPos: number, status: DSDStatus, inverted = false): Int8Array[] {
	const frame = new Int8Array(96);
	for (let i = 0; i < DSTAR_VOICE_DIBITS; i++) {
		const symbol = dibitBuf[(dibitPos + i) % dibitBuf.length];
		const bit = ((symbol >> 1) & 1) ^ Number(inverted);
		frame[DSTAR_W[i] * 24 + DSTAR_X[i]] = bit;
	}
	status.callsign = undefined;
	return [frame];
}

/**
 * Process D-STAR header frame.
 * The header contains callsign information.
 *
 * @param dibitBuf Dibit buffer
 * @param dibitPos Current position
 * @param status DSD status to update
 */
export function processDSTARHeader(dibitBuf: Uint8Array, dibitPos: number, status: DSDStatus): void {
	// D-STAR header: 660 bits (330 dibits) with Viterbi/FEC encoding
	// Contains: Flag bytes, RPT2 callsign, RPT1 callsign, YOUR callsign, MY callsign, suffix
	// FEC decoding is complex - for initial implementation, just mark as synced

	// Try to extract raw callsign bytes (simplified, without full FEC)
	const chars: number[] = [];
	for (let i = 0; i < 8; i++) {
		let byte = 0;
		for (let b = 0; b < 4; b++) {
			const pos = dibitPos + 72 + i * 4 + b; // Skip flag bytes
			const dibit = dibitBuf[pos] & 3;
			byte = (byte << 2) | dibit;
		}
		if (byte >= 32 && byte <= 126) chars.push(byte);
	}

	if (chars.length > 0) {
		status.callsign = String.fromCharCode(...chars).trim();
	}
}

/** Number of one-bit symbols in a D-STAR voice payload. */
export const DSTAR_VOICE_DIBITS = 72;

/** Number of one-bit symbols in D-STAR slow data (3 bytes). */
export const DSTAR_SLOW_DATA_DIBITS = 24;

/** Total one-bit symbols per D-STAR voice frame. */
export const DSTAR_FRAME_DIBITS = DSTAR_VOICE_DIBITS + DSTAR_SLOW_DATA_DIBITS;

/** Number of voice frames in a D-STAR superframe */
export const DSTAR_FRAMES_PER_SUPERFRAME = 21;
