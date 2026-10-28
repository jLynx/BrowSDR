import type { Ax25Frame } from './types';

const MAX_ADDRESSES = 10;
const decoder = new TextDecoder('utf-8');
// Control characters and replacement characters from invalid UTF-8.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f\ufffd]/g;

function address(frame: Uint8Array, offset: number): { text: string; ssid: number; flag: boolean } | undefined {
	let call = '';
	for (let i = 0; i < 6; i++) {
		const byte = frame[offset + i];
		const char = byte >> 1;
		// Callsign bytes are shifted ASCII; only the SSID byte may carry the extension bit.
		if (byte & 1 || !((char >= 48 && char <= 57) || (char >= 65 && char <= 90) || char === 32)) return;
		call += String.fromCharCode(char);
	}
	call = call.trimEnd();
	if (!call || call.includes(' ')) return;
	const ssid = (frame[offset + 6] >> 1) & 15;
	return { text: ssid ? `${call}-${ssid}` : call, ssid, flag: (frame[offset + 6] & 0x80) !== 0 };
}

/** AX.25 header fields of an FCS-checked frame, or undefined when the address field is not valid AX.25. */
export function decodeAx25(frame: Uint8Array): Ax25Frame | undefined {
	const addresses: Array<NonNullable<ReturnType<typeof address>>> = [];
	let offset = 0;
	for (;;) {
		if (offset + 7 > frame.length || addresses.length === MAX_ADDRESSES) return;
		const value = address(frame, offset);
		if (!value) return;
		addresses.push(value);
		offset += 7;
		if (frame[offset - 1] & 1) break;
	}
	if (addresses.length < 2 || offset >= frame.length) return;
	const control = frame[offset++];
	// UI and I frames carry a protocol identifier; the poll/final bit does not change the frame type.
	const hasPid = (control & 0xef) === 0x03 || (control & 1) === 0;
	if (hasPid && offset >= frame.length) return;
	const pid = hasPid ? frame[offset++] : undefined;
	const digipeaters = addresses.slice(2);
	const repeated = digipeaters.map((item) => item.flag).lastIndexOf(true);
	return {
		destination: addresses[0].text,
		source: addresses[1].text,
		path: digipeaters.map((item, index) => (index === repeated ? `${item.text}*` : item.text)),
		control,
		pid,
		info: frame.subarray(offset),
	};
}

/** True for an APRS-capable UI frame with no layer-3 protocol. */
export function isAprsFrame(frame: Ax25Frame): boolean {
	return (frame.control & 0xef) === 0x03 && frame.pid === 0xf0;
}

/** One character per byte, so binary APRS fields such as Mic-E keep their offsets. */
export function latin1(bytes: Uint8Array): string {
	let text = '';
	for (const byte of bytes) text += String.fromCharCode(byte);
	return text;
}

export function printable(text: string): string {
	return text.replace(/[^\x20-\x7e]/g, (char) => `<0x${char.charCodeAt(0).toString(16).padStart(2, '0')}>`);
}

/** Human-readable text field: UTF-8 when valid, without control characters. */
export function readable(text: string): string {
	const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0));
	return decoder.decode(bytes).replace(CONTROL, '').trim();
}

/** Base-91 digits are printable ASCII offset by 33. */
export function base91(text: string): number | undefined {
	let value = 0;
	for (const char of text) {
		const digit = char.charCodeAt(0) - 33;
		if (digit < 0 || digit > 90) return;
		value = value * 91 + digit;
	}
	return value;
}
