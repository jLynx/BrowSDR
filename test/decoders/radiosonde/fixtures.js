import { RS41_MASK, RS41_SYNC, rs41Crc } from '@/worker/decoders/radiosonde/rs41';

export function frame(number = 42, extended = false) {
	const bytes = new Uint8Array(extended ? 518 : 320);
	bytes.set(RS41_SYNC.map((value, index) => value ^ RS41_MASK[index]));
	bytes[56] = extended ? 0xf0 : 0x0f;
	const block = (offset, type, data) => {
		bytes[offset] = type;
		bytes[offset + 1] = data.length;
		bytes.set(data, offset + 2);
		const crc = rs41Crc(data);
		bytes[offset + 2 + data.length] = crc & 255;
		bytes[offset + 3 + data.length] = crc >> 8;
	};
	const status = new Uint8Array(40);
	status[0] = number & 255;
	status[1] = number >> 8;
	status.set(new TextEncoder().encode('V1234567'), 2);
	status[10] = 29;
	block(57, 0x79, status);
	block(101, 0x7a, new Uint8Array(42));
	block(147, 0x7c, new Uint8Array(30));
	block(181, 0x7d, new Uint8Array(89));
	const gps = new Uint8Array(21);
	const view = new DataView(gps.buffer);
	const lat = (-36.85 * Math.PI) / 180;
	const lon = (174.76 * Math.PI) / 180;
	const altitude = 12345;
	const n = 6378137 / Math.sqrt(1 - 6.69437999014e-3 * Math.sin(lat) ** 2);
	view.setInt32(0, Math.round((n + altitude) * Math.cos(lat) * Math.cos(lon) * 100), true);
	view.setInt32(4, Math.round((n + altitude) * Math.cos(lat) * Math.sin(lon) * 100), true);
	view.setInt32(8, Math.round((n * (1 - 6.69437999014e-3) + altitude) * Math.sin(lat) * 100), true);
	view.setInt16(12, -1200, true);
	view.setInt16(14, 300, true);
	view.setInt16(16, -200, true);
	gps[18] = 10;
	block(274, 0x7b, gps);
	block(299, 0x76, new Uint8Array(bytes.length - 303));
	return bytes;
}

export function bits(bytes, inverted = false) {
	const result = Array.from({ length: 80 }, (_, index) => index & 1);
	for (let index = 0; index < bytes.length; index++) {
		const wire = bytes[index] ^ RS41_MASK[index % 64];
		for (let bit = 0; bit < 8; bit++) result.push(((wire >> bit) & 1) ^ Number(inverted));
	}
	return result;
}

export function signal(bytes, rate = 48000, offset = 0, inverted = false) {
	const symbols = bits(bytes, inverted);
	const samples = Math.ceil((symbols.length * rate) / 4800) + Math.ceil(rate * 0.02);
	const iq = new Float32Array(samples * 2);
	let phase = 0;
	for (let index = 0; index < samples; index++) {
		const bit = symbols[Math.min(symbols.length - 1, Math.floor((index * 4800) / rate))];
		phase += (2 * Math.PI * (offset + (bit ? 2400 : -2400))) / rate;
		iq[index * 2] = 0.7 * Math.cos(phase);
		iq[index * 2 + 1] = 0.7 * Math.sin(phase);
	}
	return iq;
}
