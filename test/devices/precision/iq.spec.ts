import { describe, expect, it } from 'vitest';
import { decodeStreamPcm } from '@/devices/limesdr/stream-pcm';
import { decodeHfIq } from '@/devices/airspyhf/iq-converter';
import { LimeSDRDevice } from '@/devices/limesdr/device';
import { AirspyDevice } from '@/devices/airspy';
import { AirspyHfDevice } from '@/devices/airspyhf';

describe('receiver IQ precision', () => {
	it.each([false, true])('preserves all signed 12-bit LimeSDR values (packed=%s)', (packed) => {
		const data = new DataView(new ArrayBuffer(4096));
		const words = [-2048, -2047, -17, -1, 0, 1, 17, 2047];
		for (let offset = 16, i = 0; offset < 4096; offset += packed ? 3 : 4, i += 2) {
			const a = words[i % words.length],
				b = words[(i + 1) % words.length];
			if (packed) {
				data.setUint8(offset, a & 255);
				data.setUint8(offset + 1, ((a >> 8) & 15) | ((b & 15) << 4));
				data.setUint8(offset + 2, b >> 4);
			} else {
				data.setInt16(offset, a << 4, true);
				data.setInt16(offset + 2, b << 4, true);
			}
		}
		const full = new Int16Array(4096),
			small = new Int8Array(4096);
		const count = decodeStreamPcm(data, full, packed);
		expect(decodeStreamPcm(data, small, packed)).toBe(count);
		expect([...full.slice(0, 8)]).toEqual(words.map((value) => value << 4));
		for (let i = 0; i < count; i++) expect(small[i]).toBe(full[i] >> 8);
	});

	it('decodes HF+ Q/I ordering and explicit 16/12/8-bit reduction', () => {
		const data = new DataView(new ArrayBuffer(8));
		[-32768, 32767, -17, 17].forEach((word, i) => data.setInt16(i * 2, word, true));
		expect([...decodeHfIq(data, 16)]).toEqual([32767, -32768, 17, -17]);
		expect([...decodeHfIq(data, 12)]).toEqual([32752, -32768, 16, -32]);
		expect([...decodeHfIq(data, 8)]).toEqual([127, -128, 0, -1]);
		expect(() => decodeHfIq(new DataView(new ArrayBuffer(6)), 16)).toThrow('incomplete IQ pair');
	});

	it.each([new LimeSDRDevice(), new AirspyDevice(), new AirspyHfDevice()])(
		'defaults $deviceType to native precision and exposes an 8-bit option',
		(device) => {
			expect(device.sampleFormat).toBe('int16');
			const control = device.gainControls.find((value) => value.name === 'IQ Precision')!;
			expect(control.labels?.at(-1)).toBe('8-bit');
			expect(control.default).toBe(0);
		},
	);
});
