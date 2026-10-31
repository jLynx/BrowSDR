import type { AppInstance } from '@/app/core/receiver.types';
import { surveyPlan } from '@/worker/decoders/rtk/discovery/plan';
import { isValidDisplayFrequencyMhz } from '@/radio/frequency-shift';

/** Fit the shared receive band before enabling a survey. Recorded/remote IQ stays fixed. */
export async function fitDiscoveryRange(receiver: AppInstance, start: number, end: number, recenter: boolean): Promise<void> {
	const band = discoveryBand(receiver, start, end, recenter);
	if (!band) return;
	const { centerFreq, sampleRate } = band;
	if (receiver.autoGain.active || receiver._playChanging)
		throw new Error('Finish the current receiver adjustment before applying discovery.');
	if (receiver.radio.centerFreq === centerFreq && receiver.radio.sampleRate === sampleRate) return;
	const previous = { centerFreq: receiver.radio.centerFreq, sampleRate: receiver.radio.sampleRate };
	const resume = receiver.running;
	try {
		// A rate change uses the existing stop/start path. Flush radio watchers while stopped.
		if (resume && sampleRate !== previous.sampleRate) await receiver.togglePlay();
		if (receiver.connected && centerFreq !== previous.centerFreq) {
			await receiver.backend.setFrequency(centerFreq, receiver.radio.frequencyShift);
			receiver._confirmedTuning = { centerFreq, frequencyShift: receiver.radio.frequencyShift };
		}
		Object.assign(receiver.radio, { centerFreq, sampleRate });
		receiver.view.zoomScale = 1;
		receiver.view.zoomOffset = 0;
		receiver.applyZoomToEngine();
		await receiver.$nextTick();
		if (resume && !receiver.running) {
			await receiver.togglePlay(true);
			if (!receiver.running) throw new Error('Unable to restart reception with the discovery range.');
		}
		receiver.updateAllBackendVfoParams();
		receiver.saveSetting();
		if (receiver.remoteMode === 'host')
			receiver._webrtc?.sendCommand({ type: 'sync', radio: receiver.radio, gains: receiver.gains, locks: receiver.locks });
	} catch (error) {
		await restoreBand(receiver, previous, resume);
		throw error;
	}
}

function discoveryBand(receiver: AppInstance, start: number, end: number, recenter: boolean) {
	if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('Enter finite discovery frequencies in MHz.');
	const centerFreq = (start + end) / 2;
	const requiredRate = Math.max(1000000, Math.round(end * 1e6) - Math.round(start * 1e6) + 600000);
	surveyPlan(start, end, requiredRate, centerFreq);
	if (!recenter || receiver.iqReplay || receiver.remoteMode === 'client') {
		try {
			surveyPlan(start, end, receiver.radio.sampleRate, receiver.radio.centerFreq);
		} catch {
			throw new Error(
				receiver.iqReplay
					? 'This range does not fit the recording. Use received band or load a wider recording.'
					: 'This range does not fit the received band. Adjust the host receiver or use received band.',
			);
		}
		return;
	}
	if (!isValidDisplayFrequencyMhz(centerFreq, receiver.radio.frequencyShift))
		throw new Error('The discovery center is outside the SDR frequency range after applying frequency shift.');
	const sampleRate =
		receiver.radio.sampleRate >= requiredRate
			? receiver.radio.sampleRate
			: receiver.deviceCapabilities?.sampleRates.filter((rate) => rate >= requiredRate).sort((a, b) => a - b)[0];
	if (!sampleRate)
		throw new Error(`This range needs at least ${(requiredRate / 1e6).toFixed(2)} MSPS; this receiver has no suitable sample rate.`);
	return { centerFreq, sampleRate };
}

async function restoreBand(receiver: AppInstance, previous: { centerFreq: number; sampleRate: number }, resume: boolean): Promise<void> {
	if (receiver.running && receiver.radio.sampleRate !== previous.sampleRate) await receiver.togglePlay();
	Object.assign(receiver.radio, previous);
	await receiver.$nextTick();
	if (receiver.connected) {
		try {
			await receiver.backend.setFrequency(previous.centerFreq, receiver.radio.frequencyShift);
			receiver._confirmedTuning = { centerFreq: previous.centerFreq, frequencyShift: receiver.radio.frequencyShift };
		} catch {
			if (receiver.running) await receiver.togglePlay();
			receiver.saveSetting();
			return;
		}
	}
	if (resume && !receiver.running) await receiver.togglePlay(true);
	receiver.updateAllBackendVfoParams();
	receiver.saveSetting();
}
