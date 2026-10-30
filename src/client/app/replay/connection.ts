import { markRaw } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { IqRecording } from '@/radio/iq-replay/types';
import { validateIqRecording } from '@/radio/iq-replay/metadata';
import { errorMessage } from '@/platform/errors';

export const replayMethods = {
	async connectIqReplay(this: AppInstance, recording: IqRecording) {
		if (this.remoteMode === 'client') return;
		this.showIqReplayLoader = false;
		if (this.workspace) return this.workspace.connectIqReplay(this, recording);
		return this._connectIqReplay(recording);
	},
	async _connectIqReplay(this: AppInstance, recording: IqRecording) {
		if (!this.backend || this.connected) return;
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
			Object.assign(this.radio, {
				centerFreq: (recording.centerHz + recording.frequencyShiftHz) / 1e6,
				sampleRate: recording.sampleRate,
				frequencyShift: recording.frequencyShiftHz / 1e6,
			});
			this._confirmedTuning = { centerFreq: this.radio.centerFreq, frequencyShift: this.radio.frequencyShift };
			this.view.zoomScale = 1;
			this.view.zoomOffset = 0;
			this.gains = {};
			this.gainDeviceType = 'iq-replay';
			this.deviceCapabilities = await this.backend.getDeviceCapabilities();
			this.info.device = await this.backend.info();
			this.info.boardName = this.info.device.name;
			this.deviceInfoCollapsed = true;
			this.connected = true;
			for (const vfo of this.vfos) {
				if (Math.abs(vfo.freq - this.radio.centerFreq) > recording.sampleRate / 2e6) {
					vfo.freq = this.radio.centerFreq;
					vfo.displayFreq = this.formatFreq(vfo.freq);
				}
			}
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
		if (!this.iqReplay || this._playChanging) return;
		if (this.running) await this.togglePlay();
		await this.backend.rewindIqReplay();
		this.iqReplay.progress = (await this.backend.getIqReplayProgress())!;
		await this.startStream();
	},
};

export function restoreReplaySettings(receiver: AppInstance): void {
	if (!receiver._replayPrevious) return;
	Object.assign(receiver, receiver._replayPrevious);
	receiver._confirmedTuning = { centerFreq: receiver.radio.centerFreq, frequencyShift: receiver.radio.frequencyShift };
	receiver._replayPrevious = undefined;
	receiver.iqReplay = null;
}
