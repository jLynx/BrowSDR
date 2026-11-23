import { expect, vi } from 'vitest';
import { planIqSlice } from '@/remote/iq/plan';
import { unpackIqPacket } from '@/remote/iq/packet';

/** Real host extraction and client DSP, with only the worker message ports simulated. */
export async function remoteDecode(input, params, bits, sourceRate = 1e6, sourceCenter = params.freq + 0.1) {
	vi.resetModules();
	const messages = [];
	vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
	await import('@/worker/dsp-worker');
	const send = (data) => self.onmessage({ data });
	const plan = planIqSlice(params, sourceRate, sourceCenter);
	expect(plan).not.toBeNull();
	const slice = { ...plan, index: 0, revision: 1, bits };
	await send({ type: 'init', extractOnly: true, sampleRate: sourceRate, centerFreq: sourceCenter, params });
	for (let offset = 0, chunkId = 0; offset < input.length; offset += 262144, chunkId++) {
		const chunk = Int8Array.from(input.subarray(offset, offset + 262144), (value) => Math.round(value * 127));
		await send({
			type: 'process',
			slice,
			params,
			sampleRate: sourceRate,
			centerFreq: sourceCenter,
			iqFormat: 'int8',
			chunkId,
			chunkLen: chunk.length,
			chunk: chunk.buffer,
		});
	}
	expect(messages.some((m) => m.type === 'error')).toBe(false);
	const packets = messages
		.filter((m) => m.type === 'iq_slice')
		.flatMap((m) => m.packets)
		.map(unpackIqPacket);
	expect(packets.length).toBeGreaterThan(0);
	expect(messages.some((m) => ['audio', 'ais', 'acars', 'aprs', 'ble', 'adsb'].includes(m.type))).toBe(false);
	messages.length = 0;
	await send({ type: 'init', sampleRate: plan.sampleRate, centerFreq: plan.centerFreq, params });
	let time = performance.now();
	vi.spyOn(performance, 'now').mockImplementation(() => (time += 1000));
	for (const packet of packets) {
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
		if (params.rtl433) await vi.waitFor(() => expect(messages.findLast((m) => m.type === 'rtl433_status')?.status.state).toBe('receiving'));
	}
	expect(messages.filter((m) => m.type === 'error')).toEqual([]);
	return { messages, packets, send, plan };
}

export function audioSamples(messages, protocol) {
	const blocks = messages.filter((m) => m.type === 'audio' && m.samples && m.pager === protocol).map((m) => new Float32Array(m.samples));
	const audio = new Float32Array(blocks.reduce((n, b) => n + b.length, 0));
	let offset = 0;
	for (const block of blocks) {
		audio.set(block, offset);
		offset += block.length;
	}
	return audio;
}
