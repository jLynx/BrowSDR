import { describe, expect, it } from 'vitest';
import { correctRs41 } from '@/worker/decoders/radiosonde/error-correction';
import { decodeRs41 } from '@/worker/decoders/radiosonde/rs41';
import { SondeTracker } from '@/worker/decoders/radiosonde/tracker';
import references from './recorded-frames.json';

// Factual radio data from rs1729/RS: rs41/wav/20140717_402MHz.wav
// and the extended example in rs41/rs41.txt (which has two parity errors).
const recorded = Uint8Array.from(Buffer.from(references.recorded2014, 'hex'));
const extended = Uint8Array.from(Buffer.from(references.extendedReference, 'hex'));

describe('RS41 Reed-Solomon correction', () => {
	it('preserves a real recorded codeword and its CRC-checked position', () => {
		expect(correctRs41(recorded)).toEqual(recorded);
		expect(decodeRs41(recorded)).toMatchObject({ id: 'K1930308', frame: 5047, satellites: 9 });
	});
	it.each([
		['standard', recorded],
		['extended', extended],
	])('repairs twelve damaged bytes in each interleaved word (%s)', (_name, reference) => {
		const expected = correctRs41(reference);
		expect(expected).toBeDefined();
		const damaged = expected.slice();
		for (let index = 0; index < 12; index++) {
			damaged[56 + index * 2] ^= index + 1;
			damaged[57 + index * 2] ^= index + 17;
		}
		expect(correctRs41(damaged)).toEqual(expected);
	});
	it('rejects an uncorrectable word and never modifies the input', () => {
		const damaged = recorded.slice();
		for (let index = 0; index < 20; index++) damaged[56 + index * 2] ^= index + 1;
		const before = damaged.slice();
		expect(correctRs41(damaged)).toBeUndefined();
		expect(damaged).toEqual(before);
	});
	it('requires a CRC-valid identity and GPS after correcting actual frame damage', () => {
		const damaged = recorded.slice();
		damaged[63] ^= 0x42;
		damaged[280] ^= 0x80;
		expect(decodeRs41(damaged)).toBeNull();
		const tracker = new SondeTracker();
		tracker.process(damaged, 403, 1000);
		expect(tracker.snapshot(1000)[0]).toMatchObject({ id: 'K1930308', positionTime: 1000, satellites: 9 });
	});
});
