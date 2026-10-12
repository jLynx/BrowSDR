import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdsbDemodulator } from '@/worker/decoders/adsb/demodulator';
import { AircraftTracker } from '@/worker/decoders/adsb/tracker';
import { AdsbStream } from '@/worker/decoders/adsb';
import { validAdsbFrame, updateAircraft } from '@/worker/decoders/adsb/messages';
import { airbornePosition } from '@/worker/decoders/adsb/cpr';
import { visibleAircraft, hasLivePosition } from '@/app/decoders/adsb/aircraft';
import { validAdsbMessage } from '@/worker/decoders/adsb/validation';
import { planSharedBands } from '@/worker/streams/channel-plan';
import init, { DspProcessor, alloc_float_buffer } from '../../wasm/dsp/pkg/browsdr_dsp.js';

// Published worked examples from https://mode-s.org/1090mhz/content/ads-b/.
const EVEN = '8D40621D58C382D690C8AC2863A7';
const ODD = '8D40621D58C386435CC412692AD6';
const CALLSIGN = '8D4840D6202CC371C32CE0576098';
const VELOCITY = '8D485020994409940838175B284F';
const bytes = (hex) => Uint8Array.from(hex.match(/../g), (value) => parseInt(value, 16));
afterEach(() => vi.restoreAllMocks());

function iqFrame(hex, rate = 2000000, offsetHz = 0, phaseOffset = 0) {
	const scale = rate / 2000000;
	const iq = new Float32Array(Math.ceil((600 + phaseOffset) * scale) * 2);
	const message = bytes(hex);
	const halfBits = new Set([0, 2, 7, 9]);
	for (let bit = 0; bit < 112; bit++) halfBits.add(16 + bit * 2 + ((message[bit >> 3] >> (7 - (bit & 7))) & 1 ? 0 : 1));
	for (let sample = 0; sample < iq.length / 2; sample++) {
		const halfBit = Math.floor(sample / scale - 100 - phaseOffset);
		const amplitude = halfBits.has(halfBit) ? 0.7 : 0.001;
		const phase = (2 * Math.PI * offsetHz * sample) / rate;
		iq[sample * 2] = amplitude * Math.cos(phase);
		iq[sample * 2 + 1] = amplitude * Math.sin(phase);
	}
	return iq;
}

describe('1090ES ADS-B', () => {
	it.each(['0000', '0123', '1200', '7500', '7600', '7700'])('decodes TC28 identity squawk %s including leading zeroes', (squawk) => {
		const frame = new Uint8Array(14);
		frame[4] = (28 << 3) | 1;
		// Independent bit layout for the 13-bit Mode A identity field.
		const digits = [...squawk].map(Number);
		const layout = [[2, 0], [0, 0], [2, 1], [0, 1], [2, 2], [0, 2], null, [1, 0], [3, 0], [1, 1], [3, 1], [1, 2], [3, 2]];
		layout.forEach((entry, i) => {
			if (entry && (digits[entry[0]] >> entry[1]) & 1) frame[(43 + i) >> 3] |= 1 << (7 - ((43 + i) & 7));
		});
		const aircraft = { icao: '123456', lastSeen: 0, messages: 0 };
		updateAircraft(frame, aircraft, 1000);
		expect(aircraft.squawk).toBe(squawk);
		expect(
			validAdsbMessage({
				type: 'adsb',
				freq: 1090,
				status: { state: 'receiving', samples: 0, frames: 0, message: '' },
				aircraft: [aircraft],
			}),
		).toBe(true);
		aircraft.squawk = '8888';
		expect(
			validAdsbMessage({
				type: 'adsb',
				freq: 1090,
				status: { state: 'receiving', samples: 0, frames: 0, message: '' },
				aircraft: [aircraft],
			}),
		).toBe(false);
	});
	it('validates known CRCs and rejects corruption and non-DF17 data', () => {
		for (const frame of [EVEN, ODD, CALLSIGN, VELOCITY]) expect(validAdsbFrame(bytes(frame))).toBe(true);
		const damaged = bytes(EVEN);
		damaged[6] ^= 4;
		expect(validAdsbFrame(damaged)).toBe(false);
		expect(validAdsbFrame(bytes('00000000000000'))).toBe(false);
	});
	it('decodes published callsign, altitude, velocity and global position examples', () => {
		const tracker = new AircraftTracker();
		tracker.process(bytes(CALLSIGN), 10000);
		tracker.process(bytes(VELOCITY), 10000);
		tracker.process(bytes(EVEN), 10000);
		tracker.process(bytes(ODD), 10500);
		const result = tracker.snapshot(10500);
		expect(result.find((item) => item.icao === '4840D6').callsign).toBe('KLM1023');
		expect(result.find((item) => item.icao === '485020')).toMatchObject({ speed: 159, verticalRate: -832 });
		expect(result.find((item) => item.icao === '485020').heading).toBeCloseTo(182.88, 1);
		const aircraft = result.find((item) => item.icao === '40621D');
		expect(aircraft.altitude).toBe(38000);
		expect(aircraft.latitude).toBeCloseTo(52.26578, 4);
		expect(aircraft.longitude).toBeCloseTo(3.93891, 4);
		expect(aircraft).not.toHaveProperty('even');
	});
	it('requires a fresh matching position pair, expires coordinates and removes old aircraft', () => {
		const tracker = new AircraftTracker();
		tracker.process(bytes(EVEN), 10000);
		tracker.process(bytes(ODD), 21000);
		expect(tracker.snapshot(21000)[0]).not.toHaveProperty('latitude');
		tracker.process(bytes(EVEN), 21500);
		expect(tracker.snapshot(21500)[0]).toHaveProperty('latitude');
		expect(tracker.snapshot(52000)[0]).not.toHaveProperty('latitude');
		expect(tracker.snapshot(142000)).toEqual([]);
		const even = { latitude: 93000, longitude: 51372, odd: false, time: 1000, gnss: false };
		expect(airbornePosition(even, { ...even, odd: true, gnss: true })).toBeUndefined();
	});
	it.each([2, 14, 158, 480, 998])('decodes PPM bursts across blocks of %i IQ values without replay', (block) => {
		const frames = [];
		const decoder = new AdsbDemodulator((frame) => frames.push([...frame]));
		const iq = iqFrame(EVEN);
		for (let offset = 0; offset < iq.length; offset += block) decoder.process(iq.subarray(offset, offset + block));
		decoder.process(new Float32Array(0));
		expect(frames).toEqual([[...bytes(EVEN)]]);
	});
	it.each([2000000, 2400000, 4000000, 10000000, 20000000, 61440000])(
		'decodes through the actual Rust DDC at %i input samples/s',
		async (rate) => {
			const wasm = await init({ module_or_path: readFileSync(new URL('../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url)) });
			const messages = [];
			const stream = new AdsbStream(DspProcessor, wasm.memory, (message) => messages.push(message));
			stream.configure({ freq: 1090, adsb: true, enabled: false }, rate, rate === 2000000 ? 1090 : 1089.9);
			const iq = iqFrame(EVEN, rate, rate === 2000000 ? 0 : 100000);
			const ptr = alloc_float_buffer(2048);
			const spy = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 10000);
			for (let offset = 0; offset < iq.length; offset += 2048) {
				const block = iq.subarray(offset, offset + 2048);
				new Float32Array(wasm.memory.buffer, ptr, block.length).set(block);
				stream.process(ptr, block.length, true);
				spy.mockReturnValue(performance.now() + 500);
			}
			spy.mockReturnValue(performance.now() + 1000);
			new Float32Array(wasm.memory.buffer, ptr, 2048).fill(0.001);
			stream.process(ptr, 2048, true);
			stream.process(ptr, 0, true);
			expect(messages.at(-1).status.frames).toBe(1);
			expect(messages.at(-1).aircraft[0].icao).toBe('40621D');
			stream.reset();
			spy.mockRestore();
		},
	);
	it('reports unsupported tuning and sample rates once and resets on disable', () => {
		const messages = [];
		const stream = new AdsbStream(null, {}, (message) => messages.push(message));
		for (let i = 0; i < 5; i++) stream.configure({ freq: 1090, adsb: true }, 1000000, 1090);
		expect(messages).toHaveLength(1);
		expect(messages[0].status.message).toContain('2 MHz');
		stream.configure({ freq: 1090, adsb: false }, 1000000, 1090);
		expect(messages.at(-1).status.state).toBe('off');
		stream.configure({ freq: 978, adsb: true }, 4000000, 978);
		expect(messages.at(-1).status.message).toContain('1090');
	});
	it('keeps muted wideband ADS-B VFOs on the direct IQ route', () => {
		const values = [1090, 1090, 1090].map((freq) => ({ freq, mode: 'nfm', bandwidth: 12500, enabled: false, adsb: true }));
		const plan = planSharedBands(20000000, 1090, values, true);
		expect(plan.direct).toEqual([0, 1, 2]);
	});
	it('validates remote snapshots and expires UI markers when input stops', () => {
		const item = { icao: '40621D', lastSeen: 100000, messages: 2, latitude: 0, longitude: 0, positionTime: 100000 };
		const message = {
			type: 'adsb',
			freq: 1090,
			status: { state: 'receiving', message: 'Listening', frames: 2, samples: 100 },
			aircraft: [item],
		};
		expect(validAdsbMessage(message)).toBe(true);
		expect(validAdsbMessage({ ...message, aircraft: [{ ...item, latitude: 100 }] })).toBe(false);
		expect(validAdsbMessage({ ...message, aircraft: [{ ...item, longitude: NaN }] })).toBe(false);
		expect(visibleAircraft([[item], [item]], 100001)).toHaveLength(1);
		expect(hasLivePosition(item, 100001)).toBe(true);
		expect(hasLivePosition(item, 130001)).toBe(false);
		expect(visibleAircraft([[item]], 220001)).toEqual([]);
	});
});
