export function crc24q(bytes: Uint8Array): number {
	let crc = 0;
	for (const byte of bytes) {
		crc ^= byte << 16;
		for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x800000 ? 0x1864cfb : 0)) & 0xffffff;
	}
	return crc;
}

/** A container must hold exactly one complete, CRC-verified RTCM3 frame. */
export function validRtcmFrame(frame: Uint8Array): boolean {
	if (frame.length < 9 || frame[0] !== 0xd3 || frame[1] & 0xfc) return false;
	const length = ((frame[1] & 3) << 8) | frame[2];
	if (frame.length !== length + 6) return false;
	const crc = (frame[length + 3] << 16) | (frame[length + 4] << 8) | frame[length + 5];
	return crc24q(frame.subarray(0, length + 3)) === crc;
}
