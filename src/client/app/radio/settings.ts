import type { AppInstance } from '@/app/core/receiver.types';
import { makeDefaultVfo } from '@/app/core/constants';
import { normalizeSpectrumFps } from '@/display/spectrum-rate';
import { DEFAULT_FFT_SIZE, normalizedSpectrumRange, SPECTRUM_RANGE_VERSION } from '@/display/spectrum-range';
import { isRecord, restoreFields, primitiveMap } from '@/platform/data';

export const settingsMethods = {
	saveSetting(this: AppInstance) {
		const obj = {
			spectrumRangeVersion: SPECTRUM_RANGE_VERSION,
			radio: this.radio,
			display: this.display,
			gains: Object.fromEntries(Object.entries(this.gains || {}).filter(([name]) => name !== 'Receive Mode')),
			locks: this.locks,
			vfos: this.vfos,
			view: this.view,
			collapsedPanels: this.collapsedPanels,
			recentRemoteIds: this.recentRemoteIds,
		};
		const json = JSON.stringify(obj);
		localStorage.setItem(this.settingsKey || 'SDRSetting', json);
		// Startup displays the first local receiver before hardware is connected.
		// Keep that copy current without allowing other SDRs or remote sessions
		// to replace the configuration shown on the next page load.
		const first = this.workspace?.receivers[0];
		if (first && this.workspace?.mode !== 'client' && first.id === this.receiverId && !first.remote) {
			localStorage.setItem('SDRSetting', json);
		}
	},
	loadSetting(this: AppInstance, useLegacy = false) {
		try {
			const json = localStorage.getItem(this.settingsKey || 'SDRSetting') || (useLegacy ? localStorage.getItem('SDRSetting') : null);
			if (json) {
				const setting: unknown = JSON.parse(json);
				if (!isRecord(setting)) return;
				if (setting.radio) {
					restoreFields(this.radio, setting.radio);
					// Migrate: enforce minimum fftSize (old saves may have used 2048)
					if (!this.radio.fftSize || this.radio.fftSize < 8192) {
						this.radio.fftSize = DEFAULT_FFT_SIZE;
					}
				}
				restoreDisplaySettings.call(this, setting);
				if (primitiveMap<number>(setting.gains, 'number')) {
					Object.assign(this.gains, setting.gains);
					// Diagnostic reception is temporary and must never survive a reload.
					delete this.gains['Receive Mode'];
				}
				if (primitiveMap<boolean>(setting.locks, 'boolean')) Object.assign(this.locks, setting.locks);
				// Handle new format (vfos array) or legacy format (audio/audio2)
				restoreVfoSettings.call(this, setting);
				if (typeof setting.activeVfoIndex === 'number') this.activeVfoIndex = setting.activeVfoIndex;
				else if (typeof setting.activeVfo === 'number') this.activeVfoIndex = setting.activeVfo - 1;
				if (setting.view) restoreFields(this.view, setting.view);
				if (primitiveMap<boolean>(setting.collapsedPanels, 'boolean')) Object.assign(this.collapsedPanels, setting.collapsedPanels);
				if (Array.isArray(setting.recentRemoteIds))
					this.recentRemoteIds = setting.recentRemoteIds.filter((id: unknown): id is string => typeof id === 'string');
			}
		} catch (_e) {
			/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
		}
	},
	requestOrApplyChange(this: AppInstance, target: string, property: string, value: number) {
		if (this.remoteMode === 'client') {
			this._webrtc?.sendCommand({ type: 'requestChange', target, property, value });
		} else {
			if (
				target === 'radio' &&
				(property === 'centerFreq' || property === 'frequencyShift' || property === 'sampleRate' || property === 'fftSize')
			) {
				this.radio[property] = value;
			} else if (target === 'gains') {
				this.gains[property] = value;
			}
		}
	},
};

function restoreDisplaySettings(this: AppInstance, setting: Record<string, unknown>) {
	if (setting.display) restoreFields(this.display, setting.display);
	if (setting.spectrumRangeVersion !== SPECTRUM_RANGE_VERSION && isRecord(setting.display)) {
		// Legacy bounds used FFT power that was N times too high. Move only
		// saved bounds, retaining any defaults for missing/invalid fields.
		const fftSize = this.radio?.fftSize || DEFAULT_FFT_SIZE;
		const range = normalizedSpectrumRange(fftSize, this.display.minDB, this.display.maxDB);
		for (const key of ['minDB', 'maxDB'] as const) {
			if (typeof setting.display[key] === 'number' && Number.isFinite(setting.display[key])) this.display[key] = range[key];
		}
	}
	this.display.spectrumFps = normalizeSpectrumFps(this.display.spectrumFps);
}

function restoreVfoSettings(this: AppInstance, setting: Record<string, unknown>) {
	if (setting.vfos && Array.isArray(setting.vfos)) {
		this.vfos = setting.vfos.map((v: unknown) => {
			const result = makeDefaultVfo();
			restoreFields(result, v);
			return result;
		});
	} else {
		if (isRecord(setting.audio)) {
			restoreFields(this.vfos[0], setting.audio);
			Object.assign(this.vfos[0], {
				enabled: false,
				displayFreq: this.formatFreq(this.vfos[0].freq),
				focused: false,
			});
		}
		if (isRecord(setting.audio2)) {
			const vfo2 = {
				...makeDefaultVfo(),
				enabled: false,
				displayFreq: this.formatFreq(typeof setting.audio2.freq === 'number' ? setting.audio2.freq : 100),
				focused: false,
			};
			restoreFields(vfo2, setting.audio2);
			vfo2.enabled = false;
			vfo2.focused = false;
			this.vfos.push(vfo2);
		}
	}
}
