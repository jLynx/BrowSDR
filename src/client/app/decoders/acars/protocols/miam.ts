import type { AcarsRecord } from '@/worker/decoders/acars/types';
import type { AcarsField, AcarsInterpretation } from '@/app/decoders/acars/types';

/** Strict ASCII85 words, with MIAM's explicit byte padding (libacars / datalink). */
function headerBytes(text: string, padding: number): Uint8Array | undefined {
	if (!text || text.length > 100 || padding > 3) return;
	const bytes: number[] = [];
	for (let index = 0; index < text.length;) {
		if (text[index] === 'z') {
			bytes.push(0, 0, 0, 0);
			index++;
			continue;
		}
		if (index + 5 > text.length) return;
		let value = 0;
		for (let digit = 0; digit < 5; digit++) {
			const code = text.charCodeAt(index++);
			if (code < 33 || code > 117) return;
			value = value * 85 + code - 33;
		}
		if (value > 0xffffffff) return;
		bytes.push(value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
	}
	if (padding >= bytes.length) return;
	return Uint8Array.from(bytes.slice(0, bytes.length - padding));
}

/** Reads verified CORE v1 headers; incomplete compressed bodies are never expanded. */
export function interpretMiam(message: AcarsRecord): AcarsInterpretation | undefined {
	if (message.label !== 'MA' || message.text.length > 8192) return;
	const frame = /^T([0-3.-])([0-3])([^|]+)\|([^]*)$/.exec(message.text.trim());
	if (!frame) return;
	const [, bodyPadding, headerPadding, encodedHeader] = frame;
	const header = headerBytes(encodedHeader, Number(headerPadding));
	if (!header || header.length < 14 || (header[0] & 15) !== 1) return;
	const type = header[0] >> 4;
	const length = (header[1] << 16) | (header[2] << 8) | header[3];
	const aircraft = String.fromCharCode(...header.slice(4, 11));
	if (!/^[. A-Z0-9-]{7}$/.test(aircraft) || !/[A-Z0-9]/.test(aircraft)) return;
	const fields = [
		{ label: 'MIAM transfer', value: 'Single transfer · CORE version 1' },
		{ label: 'Aircraft identifier (raw)', value: aircraft },
		{ label: 'Declared PDU length', value: `${length} bytes` },
	];
	if (type === 1) return interpretAck(header, length, frame[4], aircraft, fields);
	if (type === 0) return interpretData(header, length, bodyPadding, aircraft, fields);
}

function interpretAck(
	header: Uint8Array,
	length: number,
	body: string,
	aircraft: string,
	fields: AcarsField[],
): AcarsInterpretation | undefined {
	if (header.length !== 20 || length !== 20 || body.trim()) return;
	const result = header[12] >> 4;
	const resultText =
		['Acknowledged', 'Not acknowledged', 'Time expired', 'Peer aborted', 'Local abort'][result] ?? `Unknown result ${result}`;
	return {
		title: 'MIAM transfer acknowledgement',
		summary: `${aircraft} · application message ${header[11] >> 1} · ${resultText.toLowerCase()}.`,
		coverage: result <= 4 ? 'decoded' : 'partial',
		fields: [
			...fields,
			{ label: 'Acknowledged application message', value: String(header[11] >> 1) },
			{ label: 'Transfer result', value: resultText },
		],
		notes: ['This is an application-transfer acknowledgement, separate from the ACARS link acknowledgement.'],
	};
}

function interpretData(
	header: Uint8Array,
	length: number,
	bodyPadding: string,
	aircraft: string,
	fields: AcarsField[],
): AcarsInterpretation | undefined {
	const applicationType = header[13] & 15;
	const appLength = [2, 4, 6, 6][applicationType];
	if (!appLength || header.length !== 14 + appLength + 4 || length < header.length) return;
	const app = String.fromCharCode(...header.slice(14, 14 + appLength));
	if (!/^[A-Z0-9]{2,6}$/.test(app)) return;
	const compression = ((header[12] << 2) | (header[13] >> 6)) & 7;
	const encoding = (header[13] >> 4) & 3;
	const application =
		applicationType === 3
			? app
			: `${app.slice(0, 2)}${appLength >= 4 ? ` / ${app.slice(2, 4)}` : ''}${appLength === 6 ? ` / ${app.slice(4)}` : ''}`;
	return {
		title: 'MIAM application transfer',
		summary: `${aircraft} · ${application} · ${compression === 1 ? 'deflate-compressed' : compression === 0 ? 'uncompressed' : 'unknown compression'} application data.`,
		coverage: 'partial',
		coverageDetail: 'Transfer header decoded · body undecoded',
		fields: [
			...fields,
			{ label: 'Application message number', value: String(header[11] >> 1) },
			{ label: 'Application acknowledgement', value: header[11] & 1 ? 'Required' : 'Not required' },
			{ label: applicationType === 3 ? 'Application identifier' : 'Embedded label / sublabel / function', value: application },
			{ label: 'Compression', value: ['None', 'Deflate'][compression] ?? `Unknown (${compression})` },
			{ label: 'Encoding', value: ['ISO #5 text', 'Binary'][encoding] ?? `Unknown (${encoding})` },
			{ label: 'Body padding code', value: bodyPadding },
		],
		notes: [
			'The base85 transfer header is decoded. The application body remains encoded; decompression and its inner CRC are not verified.',
			'Continued transfers require every ACARS message fragment and the final ETX before their compressed body can be decoded.',
		],
	};
}
