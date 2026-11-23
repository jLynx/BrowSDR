import { downmix, unpackAudio } from '@/audio/pcm';
import type { AppInstance } from '@/app/core/receiver.types';

/** Time between network callbacks on this receiver, including main thread scheduling. */
export function recordRemotePacketArrival(app: AppInstance, now = performance.now()): void {
	const previous = app._lastRemotePacketAt;
	app._lastRemotePacketAt = now;
	if (previous === undefined) return;
	const gap = now - previous;
	if (app.remotePacketGapMs === null || gap > app.remotePacketGapMs) app.remotePacketGapMs = gap;
}

export function playRemoteAudio(app: AppInstance, chunk: ArrayBuffer): void {
	try {
		const { samples, channels } = unpackAudio(chunk);
		const vfo = app.vfos[0];
		// Host audio is already mixed. Keep a separate mono buffer for transcription
		// because playback transfers ownership of the packet to the worklet.
		const transcribe = vfo && app.whisper.active && app.whisper.status === 'ready';
		const mono = transcribe ? (channels === 1 ? samples.slice() : downmix(samples, channels)) : null;
		app.playAudio(samples, channels);
		if (mono) app._feedWhisperVfo(0, vfo.freq, mono);
	} catch (error) {
		console.error(error);
	}
}
