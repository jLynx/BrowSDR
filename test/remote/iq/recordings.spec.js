import { readFileSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Nrsc5Module from '../../../wasm/nrsc5/pkg/nrsc5.js';
import { IqSliceExtractor } from '@/remote/iq/extractor';
import { planIqSlice } from '@/remote/iq/plan';
import { unpackIqPacket } from '@/remote/iq/packet';

const binary = readFileSync(new URL('../../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url));
const hdBinary = readFileSync(new URL('../../../wasm/nrsc5/pkg/nrsc5.wasm', import.meta.url));
vi.mock('/wasm/dsp/browsdr_dsp.js', async () => {
	const dsp = await vi.importActual('../../../wasm/dsp/pkg/browsdr_dsp.js');
	const wasm = dsp.initSync({ module: binary });
	return { ...dsp, default: async () => wasm };
});
vi.mock('/wasm/nrsc5/nrsc5.js', () => ({ default: (options) => Nrsc5Module({ ...options, wasmBinary: hdBinary }) }));
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function replay(path, params, bits, seconds) {
	vi.resetModules();
	const metadata = JSON.parse(readFileSync(path.replace(/\.sigmf-data$/, '.sigmf-meta') + (params.rtk ? '.json' : ''), 'utf8'));
	expect(metadata.global['core:datatype']).toBe('ci8');
	const rate = metadata.global['core:sample_rate'],
		center = metadata.captures[0]['core:frequency'] / 1e6;
	const dsp = await import('/wasm/dsp/browsdr_dsp.js'),
		wasm = await dsp.default();
	const plan = planIqSlice(params, rate, center),
		request = { ...plan, index: 0, revision: 1, bits };
	const extractor = new IqSliceExtractor(dsp.DspProcessor, wasm.memory);
	const size = 262144,
		ptr = dsp.alloc_iq_buffer(size),
		fd = openSync(path, 'r'),
		bytes = Buffer.alloc(size);
	const result = {
		profile: params.rtkProfile ?? 'hd',
		bits,
		seconds,
		rtcm: 0,
		hops: [],
		packets: 0,
		audioValues: 0,
		energy: 0,
		status: null,
	};
	const hops = new Set();
	let hdReady = false;
	vi.stubGlobal('self', {
		postMessage: (message) => {
			if (message.type === 'error') throw new Error(message.error);
			if (message.type === 'rtk') {
				result.rtcm += message.rtcm.length;
				result.status = message.status;
				if (message.status.hopFrequencyMHz !== undefined) hops.add(message.status.hopFrequencyMHz);
			}
			if (message.type === 'hd_radio') {
				result.status = message.status;
				hdReady = message.status.state !== 'loading';
			}
			if (message.type === 'audio' && message.samples) {
				const audio = new Float32Array(message.samples);
				result.audioValues += audio.length;
				for (const value of audio) result.energy += value * value;
			}
		},
	});
	await import('@/worker/dsp-worker');
	const send = (data) => self.onmessage({ data });
	await send({ type: 'init', sampleRate: plan.sampleRate, centerFreq: plan.centerFreq, params, preserveDc: !plan.fullBand });
	let radioMs = 0;
	vi.spyOn(performance, 'now').mockImplementation(() => radioMs);
	vi.spyOn(Date, 'now').mockImplementation(() => 1700000000000 + radioMs);
	try {
		for (let offset = 0, id = 0; offset < seconds * rate * 2; offset += size, id++) {
			const count = readSync(fd, bytes, 0, Math.min(size, seconds * rate * 2 - offset), offset);
			if (!count) break;
			radioMs = ((offset + count) / (rate * 2)) * 1000;
			new Uint8Array(wasm.memory.buffer, ptr, count).set(bytes.subarray(0, count));
			for (const packet of extractor.process(request, rate, center, ptr, count, false, id).map(unpackIqPacket)) {
				const chunk = Float32Array.from(packet.samples, (value) => value * packet.scale);
				await send({
					type: 'process',
					params,
					sampleRate: packet.sampleRate,
					centerFreq: packet.centerFreq,
					floatIq: true,
					preserveDc: !packet.fullBand,
					discontinuity: packet.discontinuity,
					chunkId: packet.sequence,
					chunkLen: chunk.length,
					chunk: chunk.buffer,
				});
				result.packets++;
				if (params.mode === 'hdradio' && result.packets === 1) await vi.waitFor(() => expect(hdReady).toBe(true));
			}
		}
		result.hops = [...hops];
		if (process.env.REMOTE_IQ_RESULTS)
			writeFileSync(`${process.env.REMOTE_IQ_RESULTS}/${result.profile}-${bits}.json`, JSON.stringify(result, null, 2));
		return result;
	} finally {
		extractor.reset();
		closeSync(fd);
		dsp.free_iq_buffer(ptr, size);
		await send({ type: 'init', sampleRate: rate, centerFreq: center, params: { ...params, rtk: false, mode: 'nfm', enabled: false } });
	}
}
describe('optional private recordings through the real remote IQ codec and client DSP', () => {
	it.skipIf(!process.env.REMOTE_RTK_IQ).each(['rtk2', 'rtk3'].flatMap((profile) => [8, 16].map((bits) => [profile, bits])))(
		'%s follows hops with %s-bit transport',
		async (profile, bits) => {
			const params = {
				freq: profile === 'rtk2' ? 921.791 : 915.401,
				mode: 'nfm',
				bandwidth: 12500,
				enabled: false,
				rtk: true,
				rtkProfile: profile,
				rtkClockPpm: profile === 'rtk2' ? 10 : 0,
				rtkFollowHops: true,
			};
			const result = await replay(process.env.REMOTE_RTK_IQ, params, bits, 60);
			expect(result.rtcm).toBeGreaterThan(50);
			expect(result.hops.length).toBeGreaterThan(10);
			expect(result.status.discontinuities).toBe(0);
		},
		600000,
	);
	it.skipIf(!process.env.REMOTE_HD_IQ).each([8, 16])(
		'decodes HD station and audio with %s-bit transport',
		async (bits) => {
			const result = await replay(
				process.env.REMOTE_HD_IQ,
				{ freq: 105.3, mode: 'hdradio', bandwidth: 400000, enabled: true, hdProgram: 0 },
				bits,
				20,
			);
			expect(result.audioValues).toBeGreaterThan(96000);
			expect(result.energy / result.audioValues).toBeGreaterThan(1e-6);
			expect(result.status.station).toBe('KSMG');
			expect(result.status.frames).toBeGreaterThan(0);
		},
		120000,
	);
});
