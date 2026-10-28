import { ax25Crc } from '@/worker/decoders/aprs/hdlc';

/** AX.25 address: six shifted ASCII characters and an SSID byte with reserved bits set. */
function address(text, last) {
	const repeated = text.endsWith('*');
	const [call, ssid = '0'] = text.replace('*', '').split('-');
	const bytes = [...call.padEnd(6, ' ')].map((char) => char.charCodeAt(0) << 1);
	bytes.push(0x60 | (Number(ssid) << 1) | (repeated ? 0x80 : 0) | (last ? 1 : 0));
	return bytes;
}

/** UI frame without FCS from a TNC2-style header and a latin1 information field. */
export function ax25Frame(source, destination, path, info, { control = 0x03, pid = 0xf0 } = {}) {
	const calls = [destination, source, ...path];
	const bytes = calls.flatMap((call, index) => address(call, index === calls.length - 1));
	bytes.push(control);
	if (pid !== null) bytes.push(pid);
	for (const char of info) bytes.push(char.charCodeAt(0));
	return Uint8Array.from(bytes);
}

const FLAG = [0, 1, 1, 1, 1, 1, 1, 0];

/** Flags, bit-stuffed frame and FCS, least significant bit first, before NRZI. */
export function wireBits(payload, { flags = 32, corrupt = false } = {}) {
	const checksum = ax25Crc(payload) ^ (corrupt ? 1 : 0);
	const bits = Array.from({ length: flags }, () => FLAG).flat();
	let ones = 0;
	for (const byte of [...payload, checksum & 255, checksum >> 8])
		for (let bit = 0; bit < 8; bit++) {
			const value = (byte >> bit) & 1;
			bits.push(value);
			ones = value ? ones + 1 : 0;
			if (ones === 5) {
				bits.push(0);
				ones = 0;
			}
		}
	bits.push(...FLAG, ...FLAG, ...FLAG);
	return bits;
}

/**
 * Independently synthesize Bell 202 AFSK on an FM carrier: NRZI tones (a zero changes tone),
 * phase-continuous audio, then frequency modulation with carrier offset, twist and noise.
 */
export function afskSignal(
	bits,
	{ rate = 48000, offset = 0, deviation = 3000, twist = 1, noise = 0, lead = 0.02, baud = 1200, audioPhase = 0 } = {},
) {
	const samplesPerBit = rate / baud;
	const leadSamples = Math.round(lead * rate);
	const length = leadSamples * 2 + Math.ceil(bits.length * samplesPerBit);
	const output = new Float32Array(length * 2);
	let space = false;
	let toneIndex = -1;
	let tonePhase = audioPhase;
	let carrier = 0;
	let random = 12345;
	for (let i = 0; i < length; i++) {
		const bitIndex = Math.floor((i - leadSamples) / samplesPerBit);
		let audio = 0;
		if (bitIndex >= 0 && bitIndex < bits.length) {
			while (toneIndex < bitIndex) if (!bits[++toneIndex]) space = !space;
			tonePhase += (2 * Math.PI * (space ? 2200 : 1200)) / rate;
			audio = Math.sin(tonePhase) * (space ? twist : 1);
		}
		carrier += (2 * Math.PI * (offset + deviation * audio)) / rate;
		random = (random * 1664525 + 1013904223) >>> 0;
		output[i * 2] = 0.7 * Math.cos(carrier) + (random / 2 ** 32 - 0.5) * noise;
		random = (random * 1664525 + 1013904223) >>> 0;
		output[i * 2 + 1] = 0.7 * Math.sin(carrier) + (random / 2 ** 32 - 0.5) * noise;
	}
	return output;
}

export function packetSignal(source, destination, path, info, options = {}) {
	return afskSignal(wireBits(ax25Frame(source, destination, path, info)), options);
}
