import type { IqPacket } from './types';

const MAGIC = 0x51495342; // BSIQ
const HEADER = 48;
export const MAX_IQ_VALUES = 6000;

export function isIqPacket(buffer: ArrayBuffer): boolean {
	return buffer.byteLength >= 4 && new DataView(buffer).getUint32(0, true) === MAGIC;
}

/** Keep sequence numbers monotonic across host worker recreation. */
export function stampIqSequence(buffer: ArrayBuffer, sequence: number): void {
	new DataView(buffer).setUint32(16, sequence, true);
}

export function packIqPacket(packet: IqPacket): ArrayBuffer {
	const buffer = new ArrayBuffer(HEADER + packet.samples.byteLength);
	const view = new DataView(buffer);
	view.setUint32(0, MAGIC, true);
	view.setUint8(4, 1);
	view.setUint8(5, packet.bits);
	view.setUint8(6, (packet.discontinuity ? 1 : 0) | (packet.fullBand ? 2 : 0));
	view.setUint32(8, packet.index, true);
	view.setUint32(12, packet.revision, true);
	view.setUint32(16, packet.sequence, true);
	view.setUint32(20, packet.samples.length, true);
	view.setFloat64(24, packet.centerFreq, true);
	view.setFloat64(32, packet.sampleRate, true);
	view.setFloat32(40, packet.scale, true);
	view.setFloat32(44, packet.bandwidth, true);
	for (let i = 0; i < packet.samples.length; i++) {
		if (packet.bits === 8) view.setInt8(HEADER + i, packet.samples[i]);
		else view.setInt16(HEADER + i * 2, packet.samples[i], true);
	}
	return buffer;
}

export function unpackIqPacket(buffer: ArrayBuffer): IqPacket | null {
	if (buffer.byteLength < HEADER || !isIqPacket(buffer)) return null;
	const view = new DataView(buffer);
	const bits = view.getUint8(5);
	const values = view.getUint32(20, true);
	const sampleRate = view.getFloat64(32, true);
	const centerFreq = view.getFloat64(24, true);
	const scale = view.getFloat32(40, true);
	const bandwidth = view.getFloat32(44, true);
	if (
		view.getUint8(4) !== 1 ||
		(bits !== 8 && bits !== 16) ||
		!values ||
		values % 2 ||
		values > MAX_IQ_VALUES ||
		buffer.byteLength !== HEADER + values * (bits / 8) ||
		!validMetadata(sampleRate, centerFreq, scale, bandwidth, view.getUint8(6))
	)
		return null;
	const samples = bits === 8 ? new Int8Array(values) : new Int16Array(values);
	for (let i = 0; i < values; i++) samples[i] = bits === 8 ? view.getInt8(HEADER + i) : view.getInt16(HEADER + i * 2, true);
	return {
		index: view.getUint32(8, true),
		revision: view.getUint32(12, true),
		sequence: view.getUint32(16, true),
		bits,
		centerFreq,
		sampleRate,
		bandwidth,
		scale,
		samples,
		discontinuity: !!(view.getUint8(6) & 1),
		fullBand: !!(view.getUint8(6) & 2),
	};
}

function validMetadata(rate: number, center: number, scale: number, bandwidth: number, flags: number): boolean {
	return (
		Number.isFinite(rate) &&
		rate > 0 &&
		rate <= 100000000 &&
		Number.isFinite(center) &&
		Number.isFinite(scale) &&
		scale > 0 &&
		scale <= 100 &&
		Number.isFinite(bandwidth) &&
		bandwidth > 0 &&
		bandwidth <= rate &&
		flags <= 3
	);
}
