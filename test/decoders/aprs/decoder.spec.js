import { describe, expect, it } from 'vitest';
import { Ax25Hdlc, ax25Crc } from '@/worker/decoders/aprs/hdlc';
import { AprsDemodulator } from '@/worker/decoders/aprs/demodulator';
import { decodeAx25, latin1 } from '@/worker/decoders/aprs/ax25';
import { decodePacket } from '@/worker/decoders/aprs/packets';
import { afskSignal, ax25Frame, packetSignal, wireBits } from './fixtures';

const INFO = '!4903.50N/07201.75W-Test 001234';
const frame = () => ax25Frame('N0CALL-9', 'APRS', ['WIDE1-1*', 'WIDE2-1'], INFO);

function demodulate(iq, chunk = 1000) {
	const frames = [];
	const demodulator = new AprsDemodulator((value) => frames.push(value));
	for (let i = 0; i < iq.length; i += chunk) demodulator.process(iq.subarray(i, i + chunk));
	return frames;
}

describe('AX.25 framing', () => {
	it('matches the published CRC-16/X-25 check vector and rejects a corrupt FCS', () => {
		expect(ax25Crc(new TextEncoder().encode('123456789'))).toBe(0x906e);
		const frames = [];
		const hdlc = new Ax25Hdlc((value) => frames.push(value));
		for (const bit of [...wireBits(frame(), { corrupt: true }), ...wireBits(frame())]) hdlc.bit(bit);
		expect(frames).toEqual([frame()]);
	});
	it('decodes addresses, SSIDs and the last repeated digipeater', () => {
		const decoded = decodeAx25(frame());
		expect(decoded).toMatchObject({ source: 'N0CALL-9', destination: 'APRS', path: ['WIDE1-1*', 'WIDE2-1'], control: 3, pid: 0xf0 });
		expect(latin1(decoded.info)).toBe(INFO);
		expect(decodeAx25(ax25Frame('N0CALL', 'APRS', ['RELAY*', 'WIDE*', 'WIDE2-1'], '>x')).path).toEqual(['RELAY', 'WIDE*', 'WIDE2-1']);
	});
	it('rejects invalid address characters and keeps non-APRS frames as plain AX.25', () => {
		expect(decodeAx25(ax25Frame('n0call', 'APRS', [], INFO))).toBeUndefined();
		expect(decodeAx25(frame().subarray(0, 10))).toBeUndefined();
		const connected = decodeAx25(ax25Frame('N0CALL', 'BBS', [], 'hello', { control: 0x00, pid: 0xf0 }));
		expect(decodePacket(connected)).toMatchObject({ kind: 'ax25', source: 'N0CALL', info: 'hello' });
	});
});

describe('Bell 202 AFSK demodulation', () => {
	it.each([
		['clean', {}],
		['frequency offset and noise', { offset: 1500, noise: 0.3 }],
		['pre-emphasized space tone', { twist: 2 }],
		['de-emphasized space tone', { twist: 0.5, audioPhase: 1.3 }],
		['wide deviation', { deviation: 4500 }],
		// Click limiting must not clip a strong, over-deviated signal from an off-frequency transmitter.
		['over-deviation off frequency', { deviation: 5500, offset: -3000, twist: 2, noise: 0.3 }],
	])('decodes FM IQ with %s across arbitrary chunks', (_, options) => {
		const frames = demodulate(packetSignal('N0CALL-9', 'APRS', ['WIDE1-1*', 'WIDE2-1'], INFO, options), 734);
		expect(frames).toEqual([frame()]);
	});
	it('decodes most packets near the FM threshold', () => {
		// About 8 dB C/N in a 16 kHz channel, where the previous demodulator decoded 2 of these 16 packets.
		let decoded = 0;
		for (let k = 0; k < 16; k++) {
			const options = { noise: 1.1, offset: -1500 + 200 * k, audioPhase: k * 0.7, twist: [0.7, 1, 1.4][k % 3] };
			decoded += demodulate(packetSignal('N0CALL-9', 'APRS', ['WIDE1-1*', 'WIDE2-1'], INFO, options), 734).length;
		}
		expect(decoded).toBeGreaterThanOrEqual(10);
	});
	it('tolerates transmitter baud error', () => {
		expect(demodulate(packetSignal('N0CALL-9', 'APRS', ['WIDE1-1*', 'WIDE2-1'], INFO, { baud: 1212 }))).toEqual([frame()]);
		expect(demodulate(packetSignal('N0CALL-9', 'APRS', ['WIDE1-1*', 'WIDE2-1'], INFO, { baud: 1188 }))).toEqual([frame()]);
	});
	it('decodes consecutive packets and a 256-byte information field', () => {
		const long = ax25Frame('N0CALL', 'APRS', [], `>${'x'.repeat(255)}`);
		const iq = afskSignal([...wireBits(frame()), ...wireBits(long, { flags: 8 })]);
		expect(demodulate(iq)).toEqual([frame(), long]);
	});
	it('ignores noise without a carrier and resets partial frames', () => {
		const noise = new Float32Array(96000).map((_, index) => (Math.sin(index * 12.9898) * 43758.5453) % 1);
		expect(demodulate(noise)).toEqual([]);
		const frames = [];
		const demodulator = new AprsDemodulator((value) => frames.push(value));
		const iq = packetSignal('N0CALL-9', 'APRS', ['WIDE1-1*', 'WIDE2-1'], INFO);
		demodulator.process(iq.subarray(0, Math.floor(iq.length / 4) * 2));
		demodulator.reset();
		demodulator.process(iq.subarray(Math.floor(iq.length / 4) * 2));
		expect(frames).toEqual([]);
	});
});
