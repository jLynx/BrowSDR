import { isRecord } from '@/platform/data';
import type { AppInstance } from './core/types';
import type { Backend as BackendInstance } from '@/worker/runtime/backend';
import { createApp, markRaw } from 'vue';
import receiverTemplate from './templates/receiver';
import { createWorkspace } from './workspace/workspace';
import * as Comlink from 'comlink';
import { createAppData } from './core/state';
import { computedProperties } from './core/computed';
import { uiHelperMethods } from './core/ui-helpers';
import { connectionMethods } from './radio/connection';
import { canvasMethods, mountCanvas } from './display/canvas';
import { audioMethods } from './audio/audio';
import { vfoMethods } from './radio/vfo';
import { settingsMethods } from './radio/settings';
import { bookmarkMethods } from './workspace/bookmarks';
import { whisperMethods } from './decoders/whisper';
import { pocsagMethods } from './decoders/pocsag';
import { dsdMethods } from './decoders/dsd';
import { rdsMethods } from './decoders/rds';
import { zoomMethods } from './display/zoom';
import { remoteMethods } from './workspace/remote';
import { autoGainMethods } from './radio/auto-gain';
import { rtl433Methods } from './decoders/rtl433';
import { mountHeaderTools } from './workspace/header-tools';
import * as uiComponents from '@/ui';
import { coreCapabilityIssues } from '@/platform/browser-capabilities';

// When a new service worker takes control (after update), reload to get fresh assets
if ('serviceWorker' in navigator) {
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		window.location.reload();
	});
}

const Receiver = {
	template: receiverTemplate,
	components: uiComponents,
	props: ['receiverId', 'settingsKey', 'workspace'],
	data(this: AppInstance) {
		return { ...createAppData(), bookmarks: this.workspace?.bookmarks ?? [] };
	},
	computed: { ...computedProperties },
	methods: {
		...uiHelperMethods,
		...connectionMethods,
		...canvasMethods,
		...audioMethods,
		...vfoMethods,
		...settingsMethods,
		...bookmarkMethods,
		...whisperMethods,
		...pocsagMethods,
		...dsdMethods,
		...rdsMethods,
		...zoomMethods,
		...remoteMethods,
		...autoGainMethods,
		...rtl433Methods,
	},
	created: async function (this: AppInstance) {
		this._cleanup = [];
		const listen = (target: EventTarget, type: string, callback: () => void) => {
			target.addEventListener(type, callback);
			this._cleanup.push(() => target.removeEventListener(type, callback));
		};
		this.loadSetting();
		this.loadBookmarks();

		// Track online/offline status for PWA — disables internet-dependent features when offline
		listen(window, 'online', () => {
			this.isOnline = true;
		});
		listen(window, 'offline', () => {
			this.isOnline = false;
		});

		// Re-acquire the screen wake lock if the page becomes visible again while running
		// (the OS releases it automatically when the screen turns off)
		listen(document, 'visibilitychange', () => {
			if (document.visibilityState === 'visible' && this.running) {
				Promise.resolve(this._acquireWakeLock()).catch((error: unknown) => console.error(error));
			}
		});

		const backendWorker = new Worker(new URL('../worker/main.ts', import.meta.url), { type: 'module' });
		this._backendWorker = backendWorker;
		if (import.meta.env.DEV)
			backendWorker.addEventListener('message', (event: MessageEvent<unknown>) => {
				if (
					isRecord(event.data) &&
					event.data.type === 'sdr-debug-log' &&
					typeof event.data.message === 'string' &&
					(event.data.level === 'log' || event.data.level === 'warn' || event.data.level === 'error')
				)
					console[event.data.level](`[${this.receiverId}] ${event.data.message}`);
			});
		const Backend = Comlink.wrap<typeof BackendInstance>(backendWorker);
		this.backend = markRaw(await new Backend());
		if (this._disposed) return;
		await this.backend.init();
		if (this._disposed) return;
		if (!this.workspace?.registerReceiver(this.receiverId, this)) return;

		watchReceiverSettings.call(this);
	},
	mounted(this: AppInstance) {
		mountCanvas.call(this);
		this._disposeHeaderTools = mountHeaderTools(this);
	},
	beforeUnmount(this: AppInstance) {
		this._disposed = true;
		this._disposeHeaderTools?.();
		this._cleanup?.forEach((cleanup: () => void) => cleanup());
		this._canvasCleanup?.();
		// Workspace teardown still needs the backend to finish stopping USB/audio.
		if (!this._removing) this._backendWorker?.terminate();
		this._whisperWorker?.terminate();
		if (this._statsTimer) clearInterval(this._statsTimer);
		this._waterfallEngine?.destroy?.();
	},
};

const capabilityIssues = coreCapabilityIssues();
if (capabilityIssues.length) {
	createApp({
		components: { UiPanel: uiComponents.UiPanel, UiNotice: uiComponents.UiNotice },
		data: () => ({ issues: capabilityIssues }),
		template: `<UiPanel label="Browser requirements" :collapsible="false">
			<UiNotice v-for="issue in issues" :key="issue.title" v-bind="issue" />
		</UiPanel>`,
	}).mount('#app');
} else {
	createApp(createWorkspace(Receiver)).mount('#app');
}

function watchReceiverSettings(this: AppInstance) {
	watchRadioFrequency.call(this);

	watchFrequencyShift.call(this);

	watchGainChanges.call(this);

	this.$watch(
		'vfos',
		() => {
			for (let i = 0; i < this.vfos.length; i++) {
				if (!this.vfos[i].focused) {
					this.vfos[i].displayFreq = this.formatFreq(this.vfos[i].freq);
				}
				this.updateBackendVfoParams(i);
			}
			this.saveSetting();
		},
		{ deep: true },
	);

	this.$watch(
		'view',
		() => {
			this.applyZoomToEngine();
			this.saveSetting();
		},
		{ deep: true },
	);

	this.$watch(
		() => [this.soloAudioVfo, this.activeAudioVfos],
		() => {
			this.clearInactiveSoloAudio();
			this.flushInactiveWhisperVfos();
		},
	);

	this.$watch(
		() => this.display.spectrumFps,
		(value: number) => {
			this.saveSetting();
			if (this.backend && this.remoteMode !== 'client') {
				this.backend.setSpectrumFps(value).catch(console.error);
			}
		},
	);

	this.$watch(
		() => this.whisper.active && this.whisper.status === 'ready',
		(enabled: boolean) => {
			this.backend?.setWhisperEnabled(enabled).catch(console.error);
		},
	);

	this.$watch(
		'collapsedPanels',
		() => {
			this.saveSetting();
		},
		{ deep: true },
	);

	this.$watch(
		() => this.display.sharedChannelization,
		(_enabled: boolean) => {
			this.saveSetting();
			this.applySharedChannelization();
		},
	);

	this.$watch(
		'locks',
		() => {
			if (this.remoteMode === 'host' && this._webrtc) {
				this._webrtc?.sendCommand({ type: 'sync', locks: this.locks });
			}
			this.saveSetting();
		},
		{ deep: true },
	);
}

function watchGainChanges(this: AppInstance) {
	let gainDebounce: ReturnType<typeof setTimeout> | null = null;
	this._cleanup.push(() => {
		if (gainDebounce) clearTimeout(gainDebounce);
	});
	this.$watch(
		'gains',
		() => {
			if (this.autoGain.active) return;
			// Debounce: wait for slider to settle before sending USB commands.
			// Dragging fires many intermediate values — only the final one matters.
			if (gainDebounce) clearTimeout(gainDebounce);
			gainDebounce = setTimeout(() => {
				gainDebounce = null;
				if (this.autoGain.active) return;

				if (this.remoteMode === 'client') {
					if (!this._applyingSync) {
						for (const [name, value] of Object.entries(this.gains)) {
							this._webrtc?.sendCommand({ type: 'requestChange', target: 'gains', property: name, value });
						}
					}
					return;
				}

				if (this.running && this.connected && this.backend) {
					this.backend.setGains({ ...this.gains }).catch(console.error);
				}

				if (this.remoteMode === 'host' && this._webrtc) {
					this._webrtc?.sendCommand({ type: 'sync', gains: this.gains, locks: this.locks });
				}

				this.saveSetting();
			}, 100);
		},
		{ deep: true },
	);
}

function watchFrequencyShift(this: AppInstance) {
	let frequencyShiftDebounce: ReturnType<typeof setTimeout> | null = null;
	this._cleanup.push(() => {
		if (frequencyShiftDebounce) clearTimeout(frequencyShiftDebounce);
	});
	this.$watch(
		() => this.radio.frequencyShift,
		(newVal: number) => {
			this.saveSetting();

			// The converter belongs to the host's hardware. Remote clients receive
			// the host's shift through radio sync and cannot change it themselves.
			if (this.remoteMode === 'client') return;

			if (frequencyShiftDebounce) clearTimeout(frequencyShiftDebounce);
			frequencyShiftDebounce = setTimeout(() => {
				frequencyShiftDebounce = null;
				if (this.running && this.backend) {
					this.backend.setFrequency(this.radio.centerFreq, newVal).catch(console.error);
				}

				if (this.remoteMode === 'host' && this._webrtc) {
					this._webrtc?.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains, locks: this.locks });
				}
			}, 200);
		},
	);
}

function watchRadioFrequency(this: AppInstance) {
	let freqDebounce: ReturnType<typeof setTimeout> | null = null;
	this._cleanup.push(() => {
		if (freqDebounce) clearTimeout(freqDebounce);
	});
	this.$watch(
		() => this.radio.centerFreq,
		(newVal: number, _oldVal: number) => {
			this.saveSetting();
			// Reset zoom on radio change
			this.view.zoomScale = 1.0;
			this.view.zoomOffset = 0.0;
			this.applyZoomToEngine();

			if (this.remoteMode === 'client') {
				if (!this._applyingSync) {
					this._webrtc?.sendCommand({ type: 'requestChange', target: 'radio', property: 'centerFreq', value: newVal });
				}
				return;
			}

			// Debounce: wait for the input to settle before sending USB commands.
			// Typing "106" fires intermediate values (1, 10, 106) — each triggers a
			// full pauseRx/VCO-cal/resumeRx cycle that can leave the FC0012 PLL in a
			// bad state if changes arrive too fast.
			if (freqDebounce) clearTimeout(freqDebounce);
			freqDebounce = setTimeout(() => {
				freqDebounce = null;

				if (this.running && this.backend) {
					this.backend.setFrequency(newVal, this.radio.frequencyShift).catch(console.error);
				}

				if (this.remoteMode === 'host' && this._webrtc) {
					this._webrtc?.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains, locks: this.locks });
				}
			}, 200);
		},
	);

	this.$watch(
		() => [this.radio.sampleRate, this.radio.fftSize],
		async (newVals: number[], oldVals: number[]) => {
			this.saveSetting();
			this.view.zoomScale = 1.0;
			this.view.zoomOffset = 0.0;
			this.applyZoomToEngine();

			if (this.remoteMode === 'client') {
				if (!this._applyingSync) {
					if (newVals[0] !== oldVals[0]) {
						this._webrtc?.sendCommand({ type: 'requestChange', target: 'radio', property: 'sampleRate', value: newVals[0] });
					}
				}
				return;
			}

			if (this.running && (newVals[0] !== oldVals[0] || newVals[1] !== oldVals[1])) {
				await this.togglePlay();
				await this.togglePlay(true);
			}

			if (this.remoteMode === 'host' && this._webrtc) {
				this._webrtc?.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains, locks: this.locks });
			}
		},
		{ deep: true },
	);
}
