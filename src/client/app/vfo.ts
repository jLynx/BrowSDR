import type { AppInstance } from './types';
import { makeDefaultVfo, MODE_DEFAULTS } from './constants';

export const vfoMethods = {
	toggleVfoCheckbox(this: AppInstance, index: number) {
		const anyEnabled = this.vfos.some((v: any) => v.enabled);
		if (anyEnabled) {
			this._initAudioCtx();
		}
		// When muting a VFO, flush any partially-filled whisper buffer so the
		// recording doesn't hang waiting for samples that will never arrive.
		if (!this.vfos[index].enabled && this._whisperVfoStates?.[index]?.bufLen > 0) {
			this._flushWhisperVfoBuf(index);
		}
		this.updateBackendVfoParams(index);
	},
	applyVfoFreq(this: AppInstance, e: Event, index: number) {
		const vfo = this.vfos[index];
		vfo.focused = false;
		let val = parseFloat(vfo.displayFreq);
		if (!isNaN(val)) {
			vfo.freq = val;
			vfo.displayFreq = this.formatFreq(val);
			this.updateBackendVfoParams(index);
		} else {
			vfo.displayFreq = this.formatFreq(vfo.freq);
		}
		(e.target as HTMLElement).blur();
	},
	applyModeDefaults(this: AppInstance, index: number) {
		const vfo = this.vfos[index];
		const d = MODE_DEFAULTS[vfo.mode] || MODE_DEFAULTS.nfm;
		if (vfo.mode === 'raw') {
			vfo.bandwidth = this.radio.sampleRate;
		} else {
			vfo.bandwidth = d.bandwidth;
		}
		vfo.snapInterval = d.snapInterval;
		vfo.deEmphasis = d.deEmphasis;
		vfo.squelchEnabled = false;
		vfo.squelchLevel = -100.0;
		vfo.noiseReduction = false;
		vfo.stereo = false;
		vfo.lowPass = d.lowPass;
		vfo.highPass = false;
	},
	updateBackendVfoParams(this: AppInstance, index: number) {
		if (this.backend && this.running && index >= 0 && index < this.vfos.length) {
			const vfo = this.vfos[index];
			const params = {
				freq: vfo.freq,
				mode: vfo.mode,
				enabled: vfo.enabled,
				bandwidth: vfo.bandwidth,
				deEmphasis: vfo.deEmphasis,
				squelchEnabled: vfo.squelchEnabled,
				squelchLevel: vfo.squelchLevel,
				noiseReduction: vfo.noiseReduction,
				stereo: vfo.stereo,
				lowPass: vfo.lowPass,
				highPass: vfo.highPass,
				rds: vfo.rds,
				rdsRegion: vfo.rdsRegion,
				volume: vfo.volume,
				pocsag: vfo.pocsag,
			};

			if (this.remoteMode === 'client' && this._webrtc) {
				// In client mode the local backend has no real DSP (mock hackrf).
				// Send the VFO params to the host over the cmd channel so the host
				// can configure the correct indexed remote VFO worker.
				this._webrtc.sendCommand({ type: 'vfoUpdate', index, params });
			} else {
				this.backend.setVfoParams(index, params);
			}
		}
	},
	async addVfo(this: AppInstance) {
		const newVfo = makeDefaultVfo(this.radio.centerFreq);
		this.vfos.push(newVfo);
		if (this.backend && this.running) {
			if (this.remoteMode === 'client' && this._webrtc) {
				// Tell the host to allocate a new remote VFO worker slot.
				this._webrtc.sendCommand({ type: 'addRemoteVfo' });
				this.updateBackendVfoParams(this.vfos.length - 1);
			} else {
				await this.backend.addVfo();
				this.updateBackendVfoParams(this.vfos.length - 1);
			}
		}
		this.activeVfoIndex = this.vfos.length - 1;

		// Auto lock when 5 or more VFOs are loaded
		if (this.vfos.length >= 5 && !this.view.locked) {
			this.view.locked = true;
			this.showMsg("Display auto-locked (> 5 VFOs)");
		}
	},
	async removeVfo(this: AppInstance, index: number) {
		if (this.vfos.length <= 1) return;
		this.vfos.splice(index, 1);
		if (this.backend && this.running) {
			if (this.remoteMode === 'client' && this._webrtc) {
				this._webrtc.sendCommand({ type: 'removeRemoteVfo', index });
			} else {
				await this.backend.removeVfo(index);
			}
		}
		if (this.activeVfoIndex >= this.vfos.length) {
			this.activeVfoIndex = this.vfos.length - 1;
		}
	},
};
