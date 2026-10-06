import { describe, expect, it } from 'vitest';
import { demodulateSideband, sidebandOffsetHz } from '../src/client/worker/ssb';

describe('streaming sideband product detector', () => {
	it.each(['usb', 'lsb', 'dsb'])('%s is independent of chunk boundaries', mode => {
		const offset = sidebandOffsetHz(mode, 2800);
		const iq = new Float32Array(48000);
		for (let i = 0; i < iq.length / 2; i++) {
			const phase = 2 * Math.PI * (500 - offset) * i / 24000;
			iq[2 * i] = 0.2 * Math.cos(phase);
			iq[2 * i + 1] = 0.2 * Math.sin(phase);
		}
		const whole = new Float32Array(iq.length / 2);
		demodulateSideband(iq, whole, mode, 2800, 24000, {});
		const chunked = new Float32Array(whole.length);
		const state = {};
		for (let start = 0; start < whole.length; start += 157) {
			const end = Math.min(start + 157, whole.length);
			demodulateSideband(iq.subarray(2 * start, 2 * end), chunked.subarray(start, end), mode, 2800, 24000, state);
		}
		expect(chunked).toEqual(whole);
	});
});
