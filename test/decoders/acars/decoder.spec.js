import { describe, expect, it } from 'vitest';
import { AcarsFramer, acarsCrc } from '@/worker/decoders/acars/framing';
import { decodeAcars } from '@/worker/decoders/acars/messages';
import { AcarsDemodulator } from '@/worker/decoders/acars/demodulator';
import { AcarsLog } from '@/worker/decoders/acars/tracker';
import { payload, radioSignal, wireBytes } from './fixtures';

const feed = (decoder, bytes, invert = 0) => {
	for (const byte of bytes) for (let bit = 0; bit < 8; bit++) decoder.bit(((byte >> bit) & 1) ^ invert);
};

describe('VHF ACARS framing and messages', () => {
	it('matches the CRC-16/KERMIT check vector, accepts both polarities and rejects bad BCS or parity', () => {
		expect(acarsCrc(new TextEncoder().encode('123456789'))).toBe(0x2189);
		const frames = [];
		const decoder = new AcarsFramer((frame) => frames.push(frame));
		feed(decoder, wireBytes());
		feed(decoder, wireBytes(), 1);
		const corrupt = wireBytes();
		corrupt[15] ^= 3;
		feed(decoder, corrupt);
		const parityError = payload();
		parityError[15] ^= 0x80;
		feed(decoder, wireBytes(parityError));
		expect(frames).toEqual([payload(), payload()]);
	});
	it('reads downlink fields, uplinks, acknowledgements and continued blocks', () => {
		expect(decodeAcars(payload())).toMatchObject({
			registration: 'ZK-NZE',
			mode: '2',
			acknowledgement: 'NAK',
			label: 'H1',
			blockId: '1',
			direction: 'downlink',
			messageNumber: 'M01A',
			flight: 'ANZ001',
			text: 'ARRIVAL GATE 12\r\nETA 1234',
			continuation: false,
		});
		expect(decodeAcars(payload('GROUND MESSAGE', 'A', 0x17))).toMatchObject({
			direction: 'uplink',
			flight: undefined,
			messageNumber: undefined,
			text: 'GROUND MESSAGE',
			continuation: true,
		});
		expect(decodeAcars(payload().slice(0, 20))).toBeUndefined();
	});
	it.each([0, 0.3, 1.2, 2.1])('demodulates AM MSK IQ with arbitrary chunks and audio phase %s', (phase) => {
		const frames = [];
		const decoder = new AcarsDemodulator((frame) => frames.push(frame));
		const iq = radioSignal(payload(), 48000, 1500, phase);
		for (let i = 0; i < iq.length; i += 146) decoder.process(iq.subarray(i, i + 146));
		expect(frames).toEqual([payload()]);
	});
	it.each([-0.0002, 0.0002])('decodes maximum-length blocks with symbol clock error %s', (clockError) => {
		const frames = [];
		const decoder = new AcarsDemodulator((frame) => frames.push(frame));
		const frame = payload('X'.repeat(216));
		const iq = radioSignal(frame, 48000, -1800, 0.6, clockError);
		for (let i = 0; i < iq.length; i += 2038) decoder.process(iq.subarray(i, i + 2038));
		expect(frames).toEqual([frame]);
	});
	it('drops partial packets on reset and recovers for the next transmission', () => {
		const frames = [];
		const decoder = new AcarsDemodulator((frame) => frames.push(frame));
		const iq = radioSignal();
		decoder.process(iq.subarray(0, iq.length >> 1));
		decoder.reset();
		decoder.process(iq.subarray(iq.length >> 1));
		expect(frames).toEqual([]);
		decoder.process(iq);
		expect(frames).toEqual([payload()]);
	});
	it('bounds the log and keeps genuine retransmissions with separate receipt times', () => {
		const log = new AcarsLog();
		for (let i = 0; i < 205; i++) log.process(payload(), 1000 + i);
		expect(log.frames).toBe(205);
		expect(log.snapshot()).toHaveLength(200);
		expect(log.snapshot()[0]).toMatchObject({ id: 6, receivedAt: 1005 });
		const snapshot = log.snapshot();
		snapshot[0].text = 'modified';
		expect(log.snapshot()[0].text).not.toBe('modified');
	});
});
