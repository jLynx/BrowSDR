import type { SdrDevice } from '@/radio/types';
import type { Backend } from '@/worker/runtime/backend';
import { initializePerformanceReporting } from './performance';

export async function configureReceiveGains(device: SdrDevice, gains?: Record<string, number>) {
	if (!gains) return;
	if (device.setGains) await device.setGains(gains);
	else for (const [name, value] of Object.entries(gains)) await device.setGain(name, value);
}

/** No spectrum allocation, IQ consumer, audio batcher or VFO worker is created. */
export async function startUsbOnlyStream(backend: Backend, sampleRate: number) {
	backend._disposeChannelization?.();
	backend._disposeSpectrum?.();
	backend._iqDispatcher?.dispose();
	backend.dspWorkers?.forEach((worker) => worker.terminate());
	backend.dspWorkers = [];
	backend.vfoParams = [];
	backend.vfoStates = [];
	backend._sharedChannelStats = { bands: 0, vfos: 0, sampleRate };
	backend.setWhisperEnabled(false);
	if (backend._perfInterval) clearInterval(backend._perfInterval);
	initializePerformanceReporting(backend, { calls: 0, sum: 0, max: 0 }, sampleRate, true);
	await backend.device!.startRx(() => {});
}
