import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Rtl433Module from '../public/lib/rtl433/rtl433.js';
import { Rtl433Decoder, Rtl433Stream, rtl433ProtocolIds } from '../src/client/worker/rtl433';
import { rtl433Methods } from '../src/client/app/rtl433';
import { planSharedBands } from '../src/client/worker/channel-plan';
import init, { DspProcessor, alloc_float_buffer } from '../hackrf-web/pkg/hackrf_web.js';

const binary = readFileSync(new URL('../public/lib/rtl433/rtl433.wasm', import.meta.url));
vi.mock('/lib/rtl433/rtl433.js', () => ({ default: options => Rtl433Module({ ...options, wasmBinary: binary }) }));
afterEach(() => vi.restoreAllMocks());

// Locally generated, valid Waveman OOK frame (no downloaded fixture required).
// Nibbles encode ID D, channel 2, button 3, ON. The final short pulse is sync.
function wavemanIq(rate, carrier = 0) {
	const pulses = [];
	let samples = 0;
	const add = (us, high) => { const count = Math.round(us * rate / 1e6); pulses.push({ count, high }); samples += count; };
	add(20000, false);
	for (let repeat = 0; repeat < 4; repeat++) {
		for (const nibble of [3, 6, 14]) for (let bit = 0; bit < 4; bit++) {
			for (const one of [true, !(nibble & (1 << bit))]) { add(one ? 357 : 1064, true); add(one ? 1064 : 357, false); }
		}
		add(357, true); add(16000, false);
	}
	add(30000, false);
	const iq = new Float32Array(samples * 2);
	let pos = 0;
	for (const pulse of pulses) for (let i = 0; i < pulse.count; i++, pos++) {
		const amplitude = pulse.high ? 0.5 : 0.001;
		const phase = 2 * Math.PI * carrier * pos / rate;
		iq[2 * pos] = amplitude * Math.cos(phase); iq[2 * pos + 1] = amplitude * Math.sin(phase);
	}
	return iq;
}

describe('rtl_433 browser decoder', () => {
	it('decodes the actual WASM protocol across irregular IQ block boundaries', async () => {
		const events = [];
		const decoder = await Rtl433Decoder.create(250000, 433920000, '', event => events.push(event));
		expect(decoder.protocols.length).toBeGreaterThan(300);
		expect(decoder.protocols.some(value => value.name.includes('Waveman'))).toBe(true);
		const iq = wavemanIq(250000);
		for (let offset = 0; offset < iq.length; offset += 998) decoder.process(iq.subarray(offset, offset + 998));
		decoder.flush(); decoder.destroy();
		expect(events.length).toBeGreaterThan(0);
		expect(events[0]).toMatchObject({ model: 'Waveman-Switch', id: 'D', channel: 2, button: 3, state: 'ON' });
	});
	it('tunes and resamples real float IQ through Rust into rtl_433 while speaker audio is muted', async () => {
		const wasm = await init({ module_or_path: readFileSync(new URL('../hackrf-web/pkg/hackrf_web_bg.wasm', import.meta.url)) });
		const messages = [];
		const stream = new Rtl433Stream(DspProcessor, wasm.memory, message => messages.push(message));
		const params = { freq: 433.92, mode: 'nfm', enabled: false, rtl433: true, rtl433SampleRate: 250000 };
		stream.configure(params, 2000000, 433.8);
		await vi.waitFor(() => expect(messages.some(message => message.status?.state === 'receiving')).toBe(true));
		expect(messages.at(-1).freq).toBe(433.92);
		const iq = wavemanIq(2000000, 120000);
		const ptr = alloc_float_buffer(65536);
		for (let offset = 0; offset < iq.length; offset += 65536) {
			const chunk = iq.subarray(offset, offset + 65536);
			new Float32Array(wasm.memory.buffer, ptr, chunk.length).set(chunk);
			stream.process(ptr, chunk.length, true);
		}
		stream.process(ptr, 0, true);
		expect(messages.find(message => message.type === 'rtl433_event')?.event).toMatchObject({ model: 'Waveman-Switch', state: 'ON' });
		stream.configure({ ...params, rtl433: false }, 2000000, 433.8);
		expect(messages.at(-1).status.state).toBe('off');
	});
	it('discards a decoder that finishes loading after its VFO was disabled', async () => {
		let resolve;
		const destroy = vi.fn();
		const create = vi.spyOn(Rtl433Decoder, 'create').mockImplementation(() => new Promise(done => { resolve = done; }));
		const free = vi.fn();
		class Processor { free = free; set_if_sample_rate() {} set_bandwidth() {} }
		const messages = [];
		const stream = new Rtl433Stream(Processor, {}, message => messages.push(message));
		stream.configure({ freq: 433.92, rtl433: true }, 2000000, 433.92);
		stream.configure({ freq: 433.92, rtl433: false }, 2000000, 433.92);
		resolve({ destroy, protocols: [], activeProtocols: 1 });
		await Promise.resolve();
		expect(destroy).toHaveBeenCalledOnce(); expect(free).toHaveBeenCalledOnce();
		expect(messages.at(-1).status.state).toBe('off'); expect(create).toHaveBeenCalledOnce();
	});
	it('rejects invalid settings without flooding status messages and can be disabled', () => {
		expect(rtl433ProtocolIds(' 74, 74, 1 ')).toBe('74,1');
		expect(() => rtl433ProtocolIds('0')).toThrow();
		const messages = [];
		const stream = new Rtl433Stream(null, {}, message => messages.push(message));
		for (let i = 0; i < 10; i++) stream.configure({ freq: 433.92, rtl433: true, rtl433Protocols: 'abc' }, 2000000, 433.92);
		expect(messages).toHaveLength(1); expect(messages[0].status.state).toBe('error');
		stream.configure({ rtl433: false, rtl433Protocols: 'abc' }, 2000000, 433.92);
		expect(messages.at(-1).status.state).toBe('off');
		stream.configure({ freq: 434.8, rtl433: true, rtl433SampleRate: 1000000 }, 2000000, 433.92);
		expect(messages.at(-1).status.message).toContain('outside');
	});
	it('keeps muted sensor VFOs in shared band planning and bounds event history', () => {
		const values = [433.9, 433.92, 434].map(freq => ({ freq, mode: 'nfm', bandwidth: 12500, enabled: false, rtl433: true, rtl433SampleRate: 1000000 }));
		const plan = planSharedBands(61440000, 433.92, values, true);
		expect([...plan.direct, ...plan.bands.flatMap(band => band.vfos)].sort()).toEqual([0, 1, 2]);
		const app = { running: true, vfos: values, rtl433: { log: [], status: [] }, formatFreq: String, $refs: {}, $nextTick: fn => fn() };
		for (let i = 0; i < 1005; i++) rtl433Methods._onRtl433Message.call(app, 1, 433.92, { type: 'rtl433_event', event: { id: i } });
		expect(app.rtl433.log).toHaveLength(1000); expect(app.rtl433.log[0].event.id).toBe(5);
		rtl433Methods._onRtl433Message.call(app, 1, 400, { type: 'rtl433_event', event: { id: 'stale' } });
		expect(app.rtl433.log.at(-1).event.id).toBe(1004);
	});
});
