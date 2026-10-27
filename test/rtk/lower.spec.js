import { describe, expect, it } from 'vitest';
import { decodeBlock, decodeHeader, decodePayload } from '@/worker/decoders/rtk/coding';
import { LoraReceiver } from '@/worker/decoders/rtk/lora';
import { RtkTracker } from '@/worker/decoders/rtk/rtcm';

import { mockSymbols } from '../fixtures/rtk/mock-symbols';
import { mockRtkIq } from '../fixtures/rtk/mock-iq';
import { mockRadioPayload } from '../fixtures/rtk/mock-packet';

const options = { rate: 1, hasCrc: false, ldro: false, oversample: 4, clockPpm: 10, preamble: 16, sync: [16, 8] };
const profile = { bandwidth: 250000, oversample: 4, sync: [16, 8], ldro: false };

describe('experimental 250 kHz LoRa payload recovery', () => {
	it('recovers all 255 mock bytes without claiming checksum verification', () => {
		const payload = Uint8Array.from({ length: 255 }, (_, i) => (i * 37 + 11) & 255);
		const symbols = mockSymbols(payload, options);
		const header = decodeHeader(symbols.slice(0, 8), false);
		expect(header).toMatchObject({ length: 255, codingRate: 1, hasCrc: false });
		const packet = decodePayload(symbols, header, false, 0);
		expect(packet.data).toEqual(payload);
		expect(packet).toMatchObject({ verified: false, codingErrors: 0 });
	});

	it('detects a single parity error without guessing a corrected nibble', () => {
		// A zero block is seven all-zero CR4/5 codewords. One Gray bit flips one codeword bit.
		const errors = { detected: 0 };
		decodeBlock([1, 0, 0, 0, 0], 7, 1, errors);
		expect(errors.detected).toBe(1);
	});

	it('recovers mock IQ live across chunk boundaries and keeps unchecked packets out of the station list', () => {
		const payload = mockRadioPayload();
		const bytes = mockRtkIq(payload, options);
		const iq = Float32Array.from(new Int8Array(bytes.buffer), (n) => n / 128);
		const packets = [];
		const tracker = new RtkTracker();
		const receiver = new LoraReceiver(profile, 10, (p) => {
			packets.push(p);
			tracker.process(p);
		});
		for (let at = 0; at < iq.length; at += 8190) receiver.process(iq.subarray(at, at + 8190));
		expect(packets).toHaveLength(1);
		expect(packets[0].data).toEqual(payload);
		expect(receiver.counters).toMatchObject({ headers: 1, payloads: 1, codingErrors: 0, packets: 0, syncSymbols: [16, 8] });
		expect(tracker.snapshot()).toEqual([]);
		expect(tracker.flush()).toEqual([]);
	});
});
