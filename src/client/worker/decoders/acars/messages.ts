import type { AcarsReport } from './types';
import { oddParity } from './framing';

export function decodeAcars(frame: Uint8Array): AcarsReport | undefined {
	if (frame.length < 13 || frame.length > 240 || !frame.every(oddParity)) return;
	const bytes = frame.map((value) => value & 0x7f);
	const end = bytes[bytes.length - 1];
	if (end !== 0x03 && end !== 0x17) return;
	const string = (start: number, finish: number) => String.fromCharCode(...bytes.subarray(start, finish));
	const blockId = string(11, 12);
	const downlink = /^[0-9]$/.test(blockId);
	const registration = string(1, 8)
		.replace(/^\.+|\.+$/g, '')
		.trim();
	if (!registration || !/^[\x20-\x7e]{1,7}$/.test(registration)) return;
	if (!validTextStart(bytes)) return;
	const hasText = bytes[12] === 0x02;
	if (hasText && downlink && bytes.length < 24) return;
	return {
		registration,
		mode: string(0, 1),
		acknowledgement: bytes[8] === 0x15 ? 'NAK' : string(8, 9),
		label: string(9, 11).replace(/\x7f/g, 'd'),
		blockId,
		direction: downlink ? 'downlink' : 'uplink',
		messageNumber: hasText && downlink ? string(13, 17).trim() : undefined,
		flight: hasText && downlink ? string(17, 23).trim() : undefined,
		text: hasText ? string(downlink ? 23 : 13, bytes.length - 1) : '',
		continuation: end === 0x17,
	};
}

function validTextStart(bytes: Uint8Array): boolean {
	return bytes[12] === 0x02 || (bytes.length === 13 && bytes[12] === 0x03);
}
