import { afterEach, describe, expect, it, vi } from 'vitest';
import { HD_IQ_RATE, emptyHdStatus, hdProgram } from '@/worker/decoders/hd-radio/types';
import { HdRadioStream } from '@/worker/decoders/hd-radio/stream';
import { planSharedBands } from '@/worker/streams/channel-plan';
import { routeHdRadioMessage, forwardHdRadioMessage } from '@/worker/decoders/hd-radio/routing';

const mocks = vi.hoisted(() => ({ instances: [], pending: null, emit: null, values: 100 }));
vi.mock('@/worker/decoders/hd-radio/decoder', () => ({
	HdDecoder: {
		create: vi.fn((callbacks) => {
			const decoder = { callbacks, destroy: vi.fn(), reset: vi.fn(), setProgram: vi.fn(), process: vi.fn(() => mocks.emit?.(callbacks)) };
			mocks.instances.push(decoder);
			return mocks.pending
				? new Promise((resolve) => {
						mocks.pending.resolve = () => resolve(decoder);
					})
				: Promise.resolve(decoder);
		}),
	},
}));

class Processor {
	set_if_sample_rate = vi.fn();
	set_bandwidth = vi.fn();
	free = vi.fn();
	reset = vi.fn();
	process_iq_only_ptr() {
		return 0;
	}
	process_iq_only_f32_ptr() {
		return 0;
	}
	get_iq_output_len() {
		return mocks.values;
	}
}

afterEach(() => {
	mocks.instances = [];
	mocks.pending = null;
	mocks.emit = null;
	mocks.values = 100;
	vi.clearAllMocks();
});
const params = { freq: 105.3, mode: 'hdradio', bandwidth: 400000, enabled: false, hdProgram: 0 };

describe('HD Radio stream lifecycle', () => {
	it.each([1000000, 2000000, 5000000, 10000000, 61440000])('supports %s SPS without coupling decoding to audio mute', async (rate) => {
		const messages = [];
		const stream = new HdRadioStream(Processor, { buffer: new ArrayBuffer(400) }, (message) => messages.push(message));
		stream.configure(params, rate, params.freq);
		await stream.ready;
		stream.configure({ ...params, enabled: true, volume: 90 }, rate, params.freq);
		expect(mocks.instances).toHaveLength(1);
		stream.process(0, 100, false, 1);
		expect(mocks.instances[0].process).toHaveBeenCalledOnce();
		expect(messages.at(-1).status.state).toBe('searching');
		stream.reset();
	});

	it('discards asynchronous results and callbacks after changing away from HD Radio', async () => {
		mocks.pending = {};
		const messages = [];
		const stream = new HdRadioStream(Processor, { buffer: new ArrayBuffer(400) }, (message) => messages.push(message));
		stream.configure(params, 2048000, params.freq);
		stream.configure({ ...params, mode: 'wfm' }, 2048000, params.freq);
		mocks.pending.resolve();
		await stream.ready;
		mocks.instances[0].callbacks.onText(1, 0, 'stale station', '', '', '');
		expect(mocks.instances[0].destroy).toHaveBeenCalledOnce();
		expect(messages.at(-1).status).toMatchObject({ state: 'off', station: '' });
	});

	it('selects HD subchannels without losing RF lock and resets PCM on input gaps', async () => {
		const messages = [];
		mocks.values = 74418;
		const stream = new HdRadioStream(Processor, { buffer: new ArrayBuffer(mocks.values * 4) }, (message) => messages.push(message));
		stream.configure(params, 2048000, params.freq);
		await stream.ready;
		mocks.emit = (callbacks) => {
			callbacks.onNumbers(0, 0, 0, 0);
			callbacks.onNumbers(4, 1, 9, 0);
			callbacks.onText(0, 1, 'HD2 title', 'Artist', '', '');
			callbacks.onAudio(
				1,
				Int16Array.from({ length: 16384 }, (_, i) => (i % 2 ? -16000 : 8000)),
				0,
			);
		};
		expect(stream.process(0, 100, true, 1)).toBeNull();
		stream.configure({ ...params, hdProgram: 1 }, 2048000, params.freq);
		expect(mocks.instances[0].setProgram.mock.calls).toEqual([[0], [1]]);
		expect(mocks.instances[0].reset).not.toHaveBeenCalled();
		const output = stream.process(0, 100, true, 2);
		expect(output.length).toBeGreaterThan(4000);
		expect(output[output.length - 2]).toBeGreaterThan(0);
		expect(output[output.length - 1]).toBeLessThan(0);
		expect(stream.audioActive).toBe(true);
		expect(mocks.instances).toHaveLength(1);
		mocks.emit = null;
		stream.process(0, 100, true, 4);
		expect(mocks.instances[0].reset).toHaveBeenCalledOnce();
		expect(stream.audioActive).toBe(false);
		expect(messages.at(-1).status).toMatchObject({ state: 'searching', station: '', frames: 0 });
		stream.reset();
	});

	it('uses the latest selected program when the decoder finishes loading', async () => {
		mocks.pending = {};
		const stream = new HdRadioStream(Processor, { buffer: new ArrayBuffer(400) }, () => {});
		stream.configure({ ...params, hdProgram: 2 }, 2048000, params.freq);
		stream.configure({ ...params, hdProgram: 7 }, 2048000, params.freq);
		mocks.pending.resolve();
		await stream.ready;
		expect(mocks.instances[0].setProgram).toHaveBeenCalledExactlyOnceWith(7);
		stream.reset();
	});

	it('retains muted HD VFOs in channel plans and guards local and remote telemetry after retuning', () => {
		const plan = planSharedBands(10000000, 105.3, [params, { ...params, freq: 104.5 }, { ...params, freq: 106.1 }], true);
		expect(
			plan.bands
				.flatMap((band) => band.vfos)
				.concat(plan.direct)
				.sort(),
		).toEqual([0, 1, 2]);
		const worker = {},
			callback = vi.fn();
		const backend = { dspWorkers: [worker], vfoParams: [params], _remoteHostHdRadioCb: callback };
		const message = { type: 'hd_radio', freq: params.freq, status: emptyHdStatus() };
		routeHdRadioMessage(backend, worker, message, callback);
		forwardHdRadioMessage(backend, 'client', { params: [params] }, 0, message);
		expect(callback).toHaveBeenCalledTimes(2);
		backend.vfoParams = [{ ...params, freq: 104.5 }];
		routeHdRadioMessage(backend, worker, message, callback);
		forwardHdRadioMessage(backend, 'client', { params: backend.vfoParams }, 0, message);
		expect(callback).toHaveBeenCalledTimes(2);
		expect(hdProgram(7)).toBe(7);
		for (const value of [-1, 8, 1.5, '1', NaN]) expect(hdProgram(value)).toBe(0);
		expect(HD_IQ_RATE).toBe(744187.5);
	});

	it('plays validated buffered digital PCM across RF lock loss without discarding the current block', async () => {
		const messages = [];
		mocks.values = 74418;
		const stream = new HdRadioStream(Processor, { buffer: new ArrayBuffer(mocks.values * 4) }, (message) => messages.push(message));
		stream.configure(params, 2048000, params.freq);
		await stream.ready;
		const pcm = new Int16Array(8820).fill(8000);
		mocks.emit = (callbacks) => {
			callbacks.onNumbers(0, 0, 0, 0);
			callbacks.onAudio(0, pcm, 0);
			callbacks.onNumbers(1, 0, 0, 0);
			callbacks.onAudio(0, pcm, 0);
		};
		const output = stream.process(0, 100, true, 1);
		expect(output.length).toBeGreaterThan(4700);
		expect(messages.at(-1).status.state).toBe('searching');
		expect(stream.audioActive).toBe(true);
		mocks.emit = (callbacks) => callbacks.onAudio(0, pcm, 0);
		expect(stream.process(0, 100, true, 2).length).toBeGreaterThan(4400);
		stream.reset();
	});
});
