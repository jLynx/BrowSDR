import type { AppInstance } from '@/app/core/receiver.types';
import { WavRecording } from './wav';

const recordings = new WeakMap<AppInstance, { wav: WavRecording; filename: string }>();

export const recordingMethods = {
	toggleAudioRecording(this: AppInstance) {
		if (this.audioRecording.active) {
			this.stopAudioRecording();
			return;
		}
		if (!this.running || !this.audioCtx || !this.vfos.some((vfo) => vfo.enabled && this.isFreqInBandwidth(vfo.freq))) {
			this.showMsg('Start reception and unmute a VFO before recording.');
			return;
		}
		const vfo = this.vfos[this.activeVfoIndex];
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const filename = `BrowSDR-${vfo.freq.toFixed(6)}MHz-${vfo.mode}-${timestamp}.wav`;
		recordings.set(this, { wav: new WavRecording(), filename });
		this.audioRecording.active = true;
		this.audioRecording.seconds = 0;
	},
	_recordAudioSamples(this: AppInstance, samples: Float32Array, channels: 1 | 2) {
		const recording = recordings.get(this);
		if (!recording) return;
		const full = recording.wav.append(samples, channels);
		const seconds = Math.floor(recording.wav.seconds);
		if (this.audioRecording.seconds !== seconds) this.audioRecording.seconds = seconds;
		if (full) {
			this.stopAudioRecording();
			this.showMsg('Recording saved at the five-minute limit.');
		}
	},
	stopAudioRecording(this: AppInstance) {
		const recording = recordings.get(this);
		if (!recording) return;
		recordings.delete(this);
		this.audioRecording.active = false;
		if (!recording.wav.frames) {
			this.showMsg('No audio samples received. Try recording with an unmuted VFO.');
			return;
		}
		if (this.audioRecording.url) URL.revokeObjectURL(this.audioRecording.url);
		this.audioRecording.url = URL.createObjectURL(recording.wav.finish());
		this.audioRecording.filename = recording.filename;
		this.audioRecording.seconds = recording.wav.seconds;
		this.downloadAudioRecording();
	},
	downloadAudioRecording(this: AppInstance) {
		if (!this.audioRecording.url) return;
		const link = document.createElement('a');
		link.href = this.audioRecording.url;
		link.download = this.audioRecording.filename;
		link.click();
	},
	_disposeAudioRecording(this: AppInstance) {
		recordings.delete(this);
		this.audioRecording.active = false;
		if (this.audioRecording.url) URL.revokeObjectURL(this.audioRecording.url);
		this.audioRecording.url = '';
	},
};
