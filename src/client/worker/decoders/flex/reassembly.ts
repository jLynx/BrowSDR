/**
 * FLEX reassembly support: build the user-facing message for a fragment stream
 * that was abandoned (timed out or superseded) before its final fragment. The
 * partial content is emitted as a valid, complete=true message flagged
 * `incomplete` so the UI marks it as missing fragment(s).
 */

import type { FlexMessage } from './types';
import type { ReasmSlot } from './frame.types';

const VEC_HEX_BINARY = 0x6;

/** Build an incomplete-but-valid partial message from an abandoned slot. */
export function partialMessage(s: ReasmSlot, pol: number): FlexMessage {
	return {
		capcode: s.capcode,
		phase: 'A',
		cycle: -1,
		frame: -1,
		vectorType: s.type,
		kind: s.type === VEC_HEX_BINARY ? 'HEX' : 'ALPHA',
		text: s.text,
		charStatus: s.charStatus.slice(),
		long: false,
		frag: 'C',
		msgNum: s.msgNum,
		complete: true,
		incomplete: true,
		reasmKey: s.reasmKey,
		fragCount: s.fragCount,
		inverted: pol === 1,
		sigOk: null,
		kOk: null,
	};
}
