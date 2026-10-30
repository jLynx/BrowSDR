import { markRaw } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { IqRecording } from '@/radio/iq-replay/types';
import { validateIqRecording } from '@/radio/iq-replay/metadata';
import { errorMessage } from '@/platform/errors';
import { clearDecoderSources } from '@/app/core/decoder-state';

export const replayMethods = {
	async connectIqReplay(this: AppInstance, recording: IqRecording) {
		if (!import.meta.env.DEV || this.remoteMode === 'client') return;
		this.showIqReplayLoader = false;
		if (this.workspace) return this.workspace.connectIqReplay(this, recording);
		return this._connectIqReplay(recording);
	},
	async _connectIqReplay(this: AppInstance, recording: IqRecording) {
		if (!import.meta.env.DEV || !this.backend || this.connected) return;
		validateIqRecording(recording);
		this._initAudioCtx();
		this._replayPrevious = JSON.parse(
			JSON.stringify({
				radio: { ...this.radio },
				gains: { ...this.gains },
				gainDeviceType: this.gainDeviceType,
				vfos: this.vfos.map((vfo) => ({ ...vfo })),
				view: { ...this.view },
			}),
		) as AppInstance['_replayPrevious'];
		this.iqReplay = {
			recording: markRaw(recording),
			progress: { state: 'ready', seconds: 0, duration: recording.file.size / 2 / recording.sampleRate, delaySeconds: 0 },
		};
		try {
			await this.backend.openIqReplay(recording);
			await applyRecording(this, recording);
			this.collapsedPanels.source = false;
			this.showMsg('IQ recording loaded. Configure your VFOs, then press Play.');
		} catch (error) {
			await this.backend.close();
			restoreReplaySettings(this);
			this.connected = false;
			this.deviceCapabilities = null;
			this.showMsg('Unable to load IQ recording: ' + errorMessage(error));
		}
	},
	async restartIqReplay(this: AppInstance) {
		if (!import.meta.env.DEV || !this.iqReplay || this._playChanging) return;
		if (this.running) await this.togglePlay();
		await this.backend.rewindIqReplay();
		this.iqReplay.progress = (await this.backend.getIqReplayProgress())!;
		await this.startStream();
	},
	async replaceIqReplay(this: AppInstance, recording: IqRecording) {
		if (!import.meta.env.DEV || !this.iqReplay || this._playChanging || this._removing) return;
		validateIqRecording(recording);
		this._playChanging = true;
		this.iqReplayReplacing = true;
		try {
			if (this.running) await this._togglePlay();
			await this.backend.replaceIqReplay(recording);
			await applyRecording(this, recording, true);
			clearDecoderSources(this);
			this.showIqReplayLoader = false;
			this.iqReplayReplace = false;
			this.showMsg('Recording replaced. Press Play to replay it with your existing VFOs.');
		} finally {
			this.iqReplayReplacing = false;
			this._playChanging = false;
		}
	},
};

async function applyRecording(receiver: AppInstance, recording: IqRecording, keepVfoTuning = false): Promise<void> {
	receiver.iqReplay = {
		recording: markRaw(recording),
		progress: { state: 'ready', seconds: 0, duration: recording.file.size / 2 / recording.sampleRate, delaySeconds: 0 },
	};
	Object.assign(receiver.radio, {
		centerFreq: (recording.centerHz + recording.frequencyShiftHz) / 1e6,
		sampleRate: recording.sampleRate,
		frequencyShift: recording.frequencyShiftHz / 1e6,
	});
	receiver._confirmedTuning = { centerFreq: receiver.radio.centerFreq, frequencyShift: receiver.radio.frequencyShift };
	receiver.view.zoomScale = 1;
	receiver.view.zoomOffset = 0;
	receiver.gains = {};
	receiver.gainDeviceType = 'iq-replay';
	receiver.deviceCapabilities = await receiver.backend.getDeviceCapabilities();
	receiver.info.device = await receiver.backend.info();
	receiver.info.boardName = receiver.info.device.name;
	receiver.deviceInfoCollapsed = true;
	receiver.connected = true;
	if (keepVfoTuning) return;
	for (const vfo of receiver.vfos) {
		if (Math.abs(vfo.freq - receiver.radio.centerFreq) > recording.sampleRate / 2e6) {
			vfo.freq = receiver.radio.centerFreq;
			vfo.displayFreq = receiver.formatFreq(vfo.freq);
		}
	}
}

export function restoreReplaySettings(receiver: AppInstance): void {
	if (!receiver._replayPrevious) return;
	Object.assign(receiver, receiver._replayPrevious);
	receiver._confirmedTuning = { centerFreq: receiver.radio.centerFreq, frequencyShift: receiver.radio.frequencyShift };
	receiver._replayPrevious = undefined;
	receiver.iqReplay = null;
}
