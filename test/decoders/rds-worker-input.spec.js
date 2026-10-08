import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ processors: [], decoders: [], memory: { buffer: new ArrayBuffer(65536) } }));

vi.mock('/wasm/dsp/browsdr_dsp.js', () => ({
	default: async () => ({ memory: mocks.memory }),
	set_panic_hook() {},
	alloc_iq_buffer: () => 0,
	alloc_float_buffer: () => 512,
	free_iq_buffer() {},
	SharedChannelizer: class {},
	DspProcessor: class {
		free = vi.fn();
		set_shift = vi.fn();
		process_iq_only_ptr = vi.fn(() => 4096);
		process_iq_only_f32_ptr = vi.fn(() => 4096);
		constructor(sampleRate) {
			this.sampleRate = sampleRate;
			mocks.processors.push(this);
		}
		set_if_sample_rate() {}
		set_bandwidth() {}
		set_squelch() {}
		set_wfm_mode() {}
		set_stereo() {}
		set_audio_filters() {}
		process_ptr() {
			return 4096;
		}
		process_f32_ptr() {
			return 4096;
		}
		get_output_len() {
			return 0;
		}
		get_squelch_db() {
			return -80;
		}
		get_iq_output_len() {
			return 4;
		}
	},
}));

vi.mock('@/worker/decoders/rds', () => ({
	RDSDecoder: class {
		process = vi.fn();
		setRegion = vi.fn();
		constructor() {
			mocks.decoders.push(this);
		}
	},
}));

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('RDS worker input routing', () => {
	it('switches RDS from byte IQ to shared float IQ and updates its tuning', async () => {
		vi.resetModules();
		mocks.processors.length = 0;
		mocks.decoders.length = 0;
		vi.stubGlobal('self', { postMessage: vi.fn() });
		await import('@/worker/dsp-worker');
		const params = { freq: 95.1, mode: 'wfm', enabled: true, rds: true, bandwidth: 150000 };
		const send = (data) => self.onmessage({ data });
		await send({ type: 'init', sampleRate: 2000000, centerFreq: 95, params });
		const byteRds = mocks.processors[1];
		await send({ type: 'process', sampleRate: 2000000, centerFreq: 95, params, chunkLen: 8, chunk: new Int8Array(8).buffer });
		expect(byteRds.process_iq_only_ptr).toHaveBeenCalledWith(0, 8);
		expect(mocks.decoders[0].process).toHaveBeenCalledOnce();
		await send({ type: 'configure', centerFreq: 95, params: { ...params, rdsRegion: 'na' } });
		expect(mocks.decoders).toHaveLength(1);
		expect(mocks.decoders[0].setRegion).toHaveBeenLastCalledWith('na');

		await send({
			type: 'process',
			sampleRate: 1920000,
			centerFreq: 95,
			params,
			floatIq: true,
			chunkLen: 8,
			chunk: new Float32Array(8).buffer,
		});
		const floatRds = mocks.processors[3];
		expect(byteRds.free).toHaveBeenCalledOnce();
		expect(floatRds.sampleRate).toBe(1920000);
		expect(floatRds.process_iq_only_f32_ptr).toHaveBeenCalledWith(512, 8);
		expect(floatRds.process_iq_only_ptr).not.toHaveBeenCalled();
		expect(mocks.decoders[1].process).toHaveBeenCalledOnce();

		await send({
			type: 'process',
			sampleRate: 1920000,
			centerFreq: 95.2,
			params,
			floatIq: true,
			chunkLen: 8,
			chunk: new Float32Array(8).buffer,
		});
		expect(floatRds.set_shift).toHaveBeenLastCalledWith(1920000, (params.freq - 95.2) * 1e6);
		const muted = { ...params, enabled: false };
		await send({ type: 'configure', centerFreq: 95.2, params: muted });
		const previousCalls = mocks.decoders[1].process.mock.calls.length;
		await send({
			type: 'process',
			sampleRate: 1920000,
			centerFreq: 95.2,
			params: muted,
			floatIq: true,
			chunkLen: 8,
			chunk: new Float32Array(8).buffer,
		});
		expect(mocks.decoders).toHaveLength(2);
		expect(mocks.decoders[1].process).toHaveBeenCalledTimes(previousCalls + 1);
		await send({ type: 'configure', centerFreq: 95.2, params: { ...muted, rds: false } });
		expect(floatRds.free).toHaveBeenCalledOnce();
		await send({
			type: 'process',
			sampleRate: 1920000,
			centerFreq: 95.2,
			params: { ...muted, rds: false },
			floatIq: true,
			chunkLen: 8,
			chunk: new Float32Array(8).buffer,
		});
		expect(mocks.decoders[1].process).toHaveBeenCalledTimes(previousCalls + 1);
	});
});
