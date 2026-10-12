import { describe, expect, it } from 'vitest';
import { decodeStreamPcm, readStreamComponent, streamSamplesPerPacket, streamTransferSize } from '@/devices/limesdr/stream-pcm';
import { LimeRxLevel } from '@/devices/limesdr/rx-level';

// Independent reference encoder, matching LimeSuite's Samples2FPGAPacketPayload.
function writePacked(data, offset, i, q) {
	data.setUint8(offset, i & 255);
	data.setUint8(offset + 1, ((i >> 8) & 15) | ((q & 15) << 4));
	data.setUint8(offset + 2, (q >> 4) & 255);
}

describe('LimeSDR packed 12-bit transport', () => {
	it('decodes every signed 12-bit value and asymmetric I/Q to the existing DSP scale', () => {
		const data = new DataView(new ArrayBuffer(3));
		for (let i = -2048; i <= 2047; i++) {
			const q = 2047 - (i + 2048);
			writePacked(data, 0, i, q);
			expect(readStreamComponent(data, 0, 0, true)).toBe(i * 16);
			expect(readStreamComponent(data, 0, 1, true)).toBe(q * 16);
		}
	});
	it('ignores packet headers and exactly matches 16-bit-to-int8 quantization', () => {
		const packed = new DataView(new ArrayBuffer(4096 * 4));
		const unpacked = new DataView(new ArrayBuffer(4096));
		for (let byte = 0; byte < packed.byteLength; byte++) packed.setUint8(byte, 255);
		let frame = 0;
		const expected = [];
		for (let packet = 0; packet < packed.byteLength; packet += 4096) {
			for (let offset = packet + 16; offset < packet + 4096; offset += 3) {
				const i = (frame % 4096) - 2048;
				const q = ((frame * 251) % 4096) - 2048;
				writePacked(packed, offset, i, q);
				unpacked.setInt16(16, i << 4, true);
				unpacked.setInt16(18, q << 4, true);
				const out16 = new Int8Array(2040);
				decodeStreamPcm(unpacked, out16, false);
				expected.push(out16[0], out16[1]);
				frame++;
			}
		}
		const out = new Int8Array(expected.length);
		expect(decodeStreamPcm(packed, out, true)).toBe(expected.length);
		expect([...out]).toEqual(expected);
	});
	it('keeps callback sample count within DSP capacity with 25% fewer USB bytes', () => {
		for (const packed of [false, true]) {
			const data = new DataView(new ArrayBuffer(streamTransferSize(packed)));
			const out = new Int8Array(131072 * 2);
			expect(decodeStreamPcm(data, out, packed)).toBe(130560 * 2);
		}
		expect(streamTransferSize(true)).toBe(streamTransferSize(false) * 0.75);
		expect(streamSamplesPerPacket(true)).toBe(1360);
	});
	it('rejects partial packets and oversized decoded inputs', () => {
		expect(() => decodeStreamPcm(new DataView(new ArrayBuffer(4095)), new Int8Array(2720), true)).toThrow('incomplete');
		expect(() => decodeStreamPcm(new DataView(new ArrayBuffer(4096)), new Int8Array(2040), true)).toThrow('capacity');
	});
	it('measures packed ADC amplitude and clipping before int8 reduction', () => {
		const meter = new LimeRxLevel();
		const data = new DataView(new ArrayBuffer(4096));
		for (let offset = 16; offset < 4096; offset += 3) writePacked(data, offset, -1024, 1024);
		meter.reset(1000);
		meter.observe(data, 1250, true);
		expect(meter.level.rmsDbfs).toBeCloseTo(-6.0206);
		expect(meter.level.peakDbfs).toBeCloseTo(-6.0206);
		expect(meter.level.clippedFraction).toBe(0);
		for (let offset = 16; offset < 4096; offset += 3) writePacked(data, offset, -2048, 2047);
		meter.observe(data, 1500, true);
		expect(meter.level.clippedFraction).toBe(1);
	});
});
