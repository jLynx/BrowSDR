import type { PerfCounters } from '../runtime/types';

import type { Backend } from '../runtime/backend';

export function initializePerformanceReporting(
	backend: Backend,
	channelPerf: { calls: number; sum: number; max: number },
	sampleRate: number,
) {
	const perf: PerfCounters = {
		usbCallbacks: 0, // USB transfer callbacks received
		audioCalls: 0, // times audio DSP ran
		audioSamplesOut: 0, // total audio samples produced
		dspTimeSum: 0, // cumulative DSP processing time (ms)
		dspTimeMax: 0, // worst-case DSP time this interval
		inputSamplesSum: 0, // IQ samples received
		droppedChunks: 0, // chunks where process() returned 0
		msgsSent: 0, // Comlink audio messages sent to main thread
		lastReportTime: performance.now(),
		// Snapshot for reporting
		report: {
			usbFps: 0,
			audioFps: 0,
			dspAvgMs: 0,
			dspMaxMs: 0,
			audioRate: 0,
			inputRate: 0,
			dropped: 0,
			chunkSize: 0,
		},
	};
	backend._perf = perf;

	// Update report snapshot every 500ms
	backend._perfInterval = setInterval(() => {
		const now = performance.now();
		const dt = (now - perf.lastReportTime) / 1000; // seconds
		if (dt < 0.1) return;
		perf.report = {
			usbFps: Math.round(perf.usbCallbacks / dt),
			audioFps: Math.round(perf.audioCalls / dt),
			dspAvgMs: perf.audioCalls > 0 ? (perf.dspTimeSum / perf.audioCalls).toFixed(2) : '0',
			dspMaxMs: perf.dspTimeMax.toFixed(2),
			audioRate: Math.round(perf.audioSamplesOut / dt),
			inputRate: Math.round(perf.inputSamplesSum / dt),
			dropped: perf.droppedChunks,
			chunkSize: perf.lastChunkSize || 0,
			msgRate: Math.round(perf.msgsSent / dt),
			whisperMsgRate: Math.round((perf.whisperMsgsSent ?? 0) / dt),
			channelAvgMs: channelPerf.calls ? channelPerf.sum / channelPerf.calls : 0,
			channelMaxMs: channelPerf.max,
			channelCpuMs: channelPerf.sum / dt,
		};
		reportRemotePerformance(backend, perf, dt, sampleRate);
		channelPerf.sum = 0;
		channelPerf.max = 0;
		channelPerf.calls = 0;
		perf.usbCallbacks = 0;
		perf.audioCalls = 0;
		perf.audioSamplesOut = 0;
		perf.dspTimeSum = 0;
		perf.dspTimeMax = 0;
		perf.inputSamplesSum = 0;
		perf.droppedChunks = 0;
		perf.msgsSent = 0;
		perf.whisperMsgsSent = 0;
		perf.lastReportTime = now;
	}, 500);
	return perf;
}

function reportRemotePerformance(backend: Backend, perf: PerfCounters, dt: number, sampleRate: number) {
	for (const [clientId, client] of backend._remoteClients ?? []) {
		const counters = client.perf;
		backend._remoteHostStatsCb?.(clientId, {
			...perf.report,
			source: 'host',
			audioFps: Math.round((counters?.audioCalls ?? 0) / dt),
			audioRate: Math.round((counters?.audioSamplesOut ?? 0) / dt),
			dspAvgMs: counters?.audioCalls ? (counters.dspTimeSum / counters.audioCalls).toFixed(2) : '0',
			dspMaxMs: (counters?.dspTimeMax ?? 0).toFixed(2),
			msgRate: Math.round((counters?.msgsSent ?? 0) / dt),
			channelization: client.channelization ?? { bands: 0, vfos: 0, sampleRate },
		});
		if (counters) {
			counters.audioCalls = 0;
			counters.audioSamplesOut = 0;
			counters.dspTimeSum = 0;
			counters.dspTimeMax = 0;
			counters.msgsSent = 0;
		}
	}
}
