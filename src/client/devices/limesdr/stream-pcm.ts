import { STREAM_HDR_SIZE, STREAM_PKT_SIZE, STREAM_PAYLOAD, TRANSFER_SIZE } from './protocol';
import { receiveTransferSize } from '@/radio/receive-transfer';

/** LimeSuite: two signed 12-bit components share three little-endian bytes. */
export function readStreamComponent(data: DataView, offset: number, component: 0 | 1, packed: boolean): number {
	if (!packed) return data.getInt16(offset + component * 2, true);
	const value =
		component === 0
			? data.getUint8(offset) | ((data.getUint8(offset + 1) & 0x0f) << 8)
			: (data.getUint8(offset + 1) >> 4) | (data.getUint8(offset + 2) << 4);
	// Sign-extend and left-align to the same full-scale range as the 16-bit link.
	return (value << 20) >> 16;
}

export const streamSamplesPerPacket = (packed: boolean) => STREAM_PAYLOAD / (packed ? 3 : 4);
// Maximum reads: 96 packed packets and 128 unpacked packets both produce 130560 IQ samples.
export function streamTransferSize(packed: boolean, sampleRate: number): number {
	const maximum = packed ? (TRANSFER_SIZE * 3) / 4 : TRANSFER_SIZE;
	return receiveTransferSize(sampleRate, maximum, STREAM_PKT_SIZE / streamSamplesPerPacket(packed), STREAM_PKT_SIZE);
}

/** Preserve full-scale int16 IQ, or explicitly reduce to int8 for lower memory traffic. */
export function decodeStreamPcm(data: DataView, output: Int8Array | Int16Array, packed: boolean): number {
	if (data.byteLength % STREAM_PKT_SIZE) throw new Error('LimeSDR: incomplete FPGA packet in USB transfer');
	const values = (data.byteLength / STREAM_PKT_SIZE) * streamSamplesPerPacket(packed) * 2;
	if (values > output.length) throw new Error('LimeSDR: USB samples exceed DSP input capacity');
	let pos = 0;
	const highPrecision = output instanceof Int16Array;
	for (let packet = 0; packet < data.byteLength; packet += STREAM_PKT_SIZE) {
		const end = packet + STREAM_PKT_SIZE;
		if (highPrecision) {
			for (let offset = packet + STREAM_HDR_SIZE; offset < end; offset += packed ? 3 : 4) {
				output[pos++] = readStreamComponent(data, offset, 0, packed);
				output[pos++] = readStreamComponent(data, offset, 1, packed);
			}
		} else if (packed) {
			for (let offset = packet + STREAM_HDR_SIZE; offset < end; offset += 3) {
				// Dropping four low bits equals (unpacked signed12 << 4) >> 8.
				output[pos++] = (data.getUint8(offset) >> 4) | ((data.getUint8(offset + 1) & 0x0f) << 4);
				output[pos++] = data.getUint8(offset + 2);
			}
		} else {
			for (let offset = packet + STREAM_HDR_SIZE; offset < end; offset += 4) {
				output[pos++] = data.getInt16(offset, true) >> 8;
				output[pos++] = data.getInt16(offset + 2, true) >> 8;
			}
		}
	}
	return pos;
}
