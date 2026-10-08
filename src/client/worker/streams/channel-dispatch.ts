import type { DspOutput } from '../runtime/dsp-messages';

import { planSharedBands } from './channel-plan';
import type { ChannelPlan } from './channel-plan';

import type { VfoParams, PerfCounters } from '../runtime/types';

import type { Backend } from '../runtime/backend';

export function dispatchIqChunk(
	backend: Backend,
	sampleRate: number,
	centerFreq: number,
	channel: ChannelState,
	perf: PerfCounters,
	signed: Int8Array<ArrayBufferLike>,
	chunkCounter: number,
	SAB_POOL_SIZE: number,
) {
	const targets = collectTargets(backend);
	const plannedParams = targets.map((target) =>
		target.shared ? target.params : { ...target.params, enabled: false, pocsag: false, rds: false, rtl433: false },
	);
	const plan = planSharedBands(sampleRate, backend._centerFreq ?? centerFreq, plannedParams, true);
	const nextKey = JSON.stringify([backend._centerFreq ?? centerFreq, plan.ratio, plan.bands.map((band) => band.centerBin)]);
	channel.plan = plan;
	channel.targets = targets;
	channel.key = nextKey;
	backend._sharedChannelStats = {
		bands: plan.bands.length,
		vfos: plan.bands.reduce((count, band) => count + band.vfos.length, 0),
		sampleRate: plan.sampleRate,
	};
	for (const client of backend._remoteClients?.values() ?? []) {
		const workers = new Set(client.workers);
		const bands = plan.bands
			.map((band) => band.vfos.filter((index) => workers.has(targets[index].worker)))
			.filter((indices) => indices.length);
		client.channelization = {
			bands: bands.length,
			vfos: bands.reduce((count, indices) => count + indices.length, 0),
			sampleRate: plan.sampleRate,
		};
	}
	if (plan.bands.length) {
		ensureChannelWorker(channel, perf);
		if (channel.pending < sampleRate * 0.1) {
			const buffer = signed.slice().buffer;
			channel.pending += signed.length / 2;
			channel.worker!.postMessage(
				{
					type: 'channelize',
					key: channel.key,
					ratio: plan.ratio,
					centers: plan.bands.map((band) => band.centerBin),
					sampleRate: plan.sampleRate,
					chunk: buffer,
					inputSamples: signed.length / 2,
					chunkId: chunkCounter,
				},
				[buffer],
			);
		} else perf.droppedChunks++;
	} else if (channel.worker) {
		backend._disposeChannelization?.();
	}
	for (let index = 0; index < targets.length; index++) {
		const { worker, params, shared } = targets[index];
		if (shared && !plan.direct.includes(index)) continue;
		if (!needsIq(params)) continue;
		if (typeof SharedArrayBuffer !== 'undefined') {
			worker.postMessage({
				type: 'process',
				params: params,
				sampleRate,
				centerFreq: backend._centerFreq ?? centerFreq,
				useSab: true,
				sabIndex: backend.sabPoolIndex,
				chunkLen: signed.length,
				chunkId: chunkCounter,
			});
		} else {
			const cloneBuf = signed.slice().buffer;
			worker.postMessage(
				{
					type: 'process',
					params: params,
					sampleRate,
					centerFreq: backend._centerFreq ?? centerFreq,
					useSab: false,
					chunk: cloneBuf,
					chunkLen: signed.length,
					chunkId: chunkCounter,
				},
				[cloneBuf],
			);
		}
	}

	backend.sabPoolIndex = (backend.sabPoolIndex! + 1) % SAB_POOL_SIZE;
}

export function ensureChannelWorker(channel: ChannelState, perf: PerfCounters) {
	if (!channel.worker) {
		channel.worker = new globalThis.Worker(new URL('../dsp-worker.ts', import.meta.url), { type: 'module' });
		channel.worker.onmessage = ({ data: message }: MessageEvent<DspOutput>) => {
			if (message.type !== 'bands' && message.type !== 'channel_error') return;
			channel.pending -= message.inputSamples || 0;
			if (message.type === 'channel_error') {
				console.error('Shared channelizer:', message.error);
				perf.droppedChunks++;
				return;
			}
			channel.perf.calls++;
			channel.perf.sum += message.dspTime;
			channel.perf.max = Math.max(channel.perf.max, message.dspTime);
			if (message.key !== channel.key) return;
			for (const result of message.bands) {
				const band = channel.plan?.bands.find((value) => value.centerBin === result.centerBin);
				if (!band) continue;
				for (const index of band.vfos) {
					const target = channel.targets[index];
					if (!target) continue;
					target.worker.postMessage({
						type: 'process',
						floatIq: true,
						chunk: result.buffer,
						chunkLen: result.length,
						sampleRate: channel.plan!.sampleRate,
						centerFreq: band.centerFreq,
						params: target.params,
						chunkId: message.chunkId,
					});
				}
			}
		};
	}
}

export interface ChannelState {
	worker?: Worker;
	plan?: ChannelPlan;
	targets: Array<{ worker: Worker; params: VfoParams; shared: boolean }>;
	pending: number;
	key: string;
	perf: { calls: number; sum: number; max: number };
}

function collectTargets(backend: Backend) {
	const targets = backend.dspWorkers!.map((worker, index) => ({
		worker,
		params: backend.vfoParams![index],
		shared: backend._sharedChannelization,
	}));
	for (const client of backend._remoteClients?.values() ?? []) {
		for (let index = 0; index < client.workers.length; index++) {
			const worker = client.workers[index];
			const params = client.params[index];
			if (worker && params) targets.push({ worker, params, shared: client.sharedChannelization === true });
		}
	}
	return targets;
}

function needsIq(params: VfoParams): boolean {
	return params.enabled || params.pocsag || (params.rds && params.mode === 'wfm') || params.rtl433 === true;
}
