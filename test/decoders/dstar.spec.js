import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processDSTARVoice, DSTAR_FRAME_DIBITS } from '@/worker/decoders/dsd/dsd-dstar';
import { DSDDecoder } from '@/worker/decoders/dsd/dsd-decoder';
import { SYNC_WORDS } from '@/worker/decoders/dsd/constants';
import { decodeAmbe } from '@/worker/decoders/mbelib-init';

vi.mock('@/worker/decoders/mbelib-init', () => ({
	ensureMbelibInitialized: async () => {},
	decodeAmbe: vi.fn(() => new Float32Array(160)),
	decodeImbe: vi.fn(),
	resetMbe: vi.fn(),
	getMbeErrors: () => 0,
}));

beforeEach(() => vi.clearAllMocks());

describe('D-STAR symbol interleave', () => {
	it('maps polarity bits into all four rows of one AMBE frame', () => {
		// Reference positions from DSD's dstar_const.h dW/dX schedule:
		// symbol 0 -> [0][10], 2 -> [3][11], 3 -> [2][9], 4 -> [1][10].
		const symbols = new Uint8Array(72).fill(1);
		for (const index of [0, 2, 3, 4]) symbols[index] = 3;
		const frames = processDSTARVoice(symbols, 0, {});
		expect(frames).toHaveLength(1);
		const expected = new Int8Array(96);
		for (const index of [10, 83, 57, 34]) expected[index] = 1;
		expect(frames[0]).toEqual(expected);
		expect(DSTAR_FRAME_DIBITS).toBe(96);
	});
	it('handles inverted polarity and frames spanning the circular buffer boundary', () => {
		const symbols = new Uint8Array(96).fill(3);
		symbols[94] = 1;
		const [frame] = processDSTARVoice(symbols, 94, {}, true);
		const expected = new Int8Array(96);
		expected[10] = 1;
		expect(frame).toEqual(expected);
	});
	it('treats inner and outer slicer levels with the same polarity as the same bit', () => {
		const outer = Uint8Array.from({ length: 72 }, (_, i) => (i % 2 ? 3 : 1));
		const inner = outer.map((symbol) => symbol & 2);
		expect(processDSTARVoice(inner, 0, {})).toEqual(processDSTARVoice(outer, 0, {}));
	});
	it.each(['DSTAR', 'INV_DSTAR'])('collects 96 symbols after %s sync and submits one matrix', async (sync) => {
		const decoder = new DSDDecoder(
			() => {},
			() => {},
		);
		await decoder.mbeInitPromise;
		for (const symbol of SYNC_WORDS[sync]) decoder.feedDibit(Number(symbol));
		const negativeBit = sync === 'DSTAR' ? 3 : 1;
		const positiveBit = sync === 'DSTAR' ? 1 : 3;
		decoder.feedDibit(negativeBit);
		for (let i = 1; i < 95; i++) decoder.feedDibit(positiveBit);
		expect(decodeAmbe).not.toHaveBeenCalled();
		decoder.feedDibit(positiveBit);
		const expected = new Int8Array(96);
		expected[10] = 1;
		expect(decodeAmbe).toHaveBeenCalledExactlyOnceWith(expected);
		expect(decoder.status.voiceFrameCount).toBe(1);
	});
});
