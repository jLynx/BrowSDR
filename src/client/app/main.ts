import { createApp, markRaw } from 'vue';
import receiverTemplate from './receiver.html?raw';
import VfoPanel from './vfo-panel';
import { createWorkspace } from './workspace';
import * as Comlink from 'comlink';
import { createAppData } from './state';
import { computedProperties } from './computed';
import { uiHelperMethods } from './ui-helpers';
import { connectionMethods } from './connection';
import { canvasMethods, mountCanvas } from './canvas';
import { audioMethods } from './audio';
import { vfoMethods } from './vfo';
import { settingsMethods } from './settings';
import { bookmarkMethods } from './bookmarks';
import { whisperMethods } from './whisper';
import { pocsagMethods } from './pocsag';
import { dsdMethods } from './dsd';
import { rdsMethods } from './rds';
import { zoomMethods } from './zoom';
import { remoteMethods } from './remote';
import { autoGainMethods } from './auto-gain';
import { rtl433Methods } from './rtl433';
import { mountHeaderTools } from './header-tools';
import * as uiComponents from '../ui';
import { coreCapabilityIssues } from '../browser-capabilities';

// When a new service worker takes control (after update), reload to get fresh assets
if ('serviceWorker' in navigator) {
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		window.location.reload();
	});
}

const Receiver = {
	template: receiverTemplate,
	components: { ...uiComponents, VfoPanel },
	provide(this: any) { return { receiver: this }; },
	props: ['receiverId', 'settingsKey', 'workspace'],
	data(this: any) { return { ...createAppData(), bookmarks: this.workspace.bookmarks }; },
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
	created: async function (this: any) {
		this._cleanup = [];
		const listen = (target: EventTarget, type: string, callback: () => void) => {
			target.addEventListener(type, callback);
			this._cleanup.push(() => target.removeEventListener(type, callback));
		};
		this.loadSetting();
		this.loadBookmarks();

		// Track online/offline status for PWA — disables internet-dependent features when offline
		listen(window, 'online', () => { this.isOnline = true; });
		listen(window, 'offline', () => { this.isOnline = false; });

		// Re-acquire the screen wake lock if the page becomes visible again while running
		// (the OS releases it automatically when the screen turns off)
		listen(document, 'visibilitychange', () => {
			if (document.visibilityState === 'visible' && this.running) {
				this._acquireWakeLock();
			}
		});

		const backendWorker = new Worker(new URL('../worker/main.ts', import.meta.url), { type: 'module' });
		this._backendWorker = backendWorker;
		if (import.meta.env.DEV) backendWorker.addEventListener('message', (event: MessageEvent) => {
			if (event.data?.type === 'sdr-debug-log') console[event.data.level as 'log'](`[${this.receiverId}] ${event.data.message}`);
		});
		const Backend = Comlink.wrap<any>(backendWorker);
		this.backend = markRaw(await new (Backend as any)());
		if (this._disposed) return;
		await this.backend.init();
		if (this._disposed) return;
		if (!this.workspace.registerReceiver(this.receiverId, this)) return;

		let freqDebounce: ReturnType<typeof setTimeout> | null = null;
		this._cleanup.push(() => { if (freqDebounce) clearTimeout(freqDebounce); });
		this.$watch(() => this.radio.centerFreq, async (newVal: any, oldVal: any) => {
			this.saveSetting();
			// Reset zoom on radio change
			this.view.zoomScale = 1.0;
			this.view.zoomOffset = 0.0;
			this.applyZoomToEngine();

			if (this.remoteMode === 'client') {
				if (!this._applyingSync) {
					this._webrtc.sendCommand({ type: 'requestChange', target: 'radio', property: 'centerFreq', value: newVal });
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
					this._webrtc.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains, locks: this.locks });
				}
			}, 200);
		});

		this.$watch(() => [this.radio.sampleRate, this.radio.fftSize], async (newVals: any[], oldVals: any[]) => {
			this.saveSetting();
			this.view.zoomScale = 1.0;
			this.view.zoomOffset = 0.0;
			this.applyZoomToEngine();

			if (this.remoteMode === 'client') {
				if (!this._applyingSync) {
					if (newVals[0] !== oldVals[0]) {
						this._webrtc.sendCommand({ type: 'requestChange', target: 'radio', property: 'sampleRate', value: newVals[0] });
					}
				}
				return;
			}

			if (this.running && (newVals[0] !== oldVals[0] || newVals[1] !== oldVals[1])) {
				await this.togglePlay();
				await this.togglePlay(true);
			}

			if (this.remoteMode === 'host' && this._webrtc) {
				this._webrtc.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains, locks: this.locks });
			}
		}, { deep: true });

		let frequencyShiftDebounce: ReturnType<typeof setTimeout> | null = null;
		this._cleanup.push(() => { if (frequencyShiftDebounce) clearTimeout(frequencyShiftDebounce); });
		this.$watch(() => this.radio.frequencyShift, (newVal: any) => {
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
					this._webrtc.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains, locks: this.locks });
				}
			}, 200);
		});

		let gainDebounce: ReturnType<typeof setTimeout> | null = null;
		this._cleanup.push(() => { if (gainDebounce) clearTimeout(gainDebounce); });
		this.$watch('gains', () => {
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
							this._webrtc.sendCommand({ type: 'requestChange', target: 'gains', property: name, value });
						}
					}
					return;
				}

				if (this.running && this.connected && this.backend) {
					this.backend.setGains({ ...this.gains }).catch(console.error);
				}

				if (this.remoteMode === 'host' && this._webrtc) {
					this._webrtc.sendCommand({ type: 'sync', gains: this.gains, locks: this.locks });
				}

				this.saveSetting();
			}, 100);
		}, { deep: true });

		this.$watch('vfos', () => {
			for (let i = 0; i < this.vfos.length; i++) {
				if (!this.vfos[i].focused) {
					this.vfos[i].displayFreq = this.formatFreq(this.vfos[i].freq);
				}
				this.updateBackendVfoParams(i);
			}
			this.saveSetting();
		}, { deep: true });

		this.$watch('view', () => {
			this.applyZoomToEngine();
			this.saveSetting();
		}, { deep: true });

		this.$watch(() => [this.soloAudioVfo, this.activeAudioVfos], () => {
			this.clearInactiveSoloAudio();
			this.flushInactiveWhisperVfos();
		});

		this.$watch(() => this.display.spectrumFps, (value: number) => {
			this.saveSetting();
			if (this.backend && this.remoteMode !== 'client') {
				this.backend.setSpectrumFps(value).catch(console.error);
			}
		});

		this.$watch(() => this.whisper.active && this.whisper.status === 'ready', (enabled: boolean) => {
			this.backend?.setWhisperEnabled(enabled).catch(console.error);
		});

		this.$watch('collapsedPanels', () => {
			this.saveSetting();
		}, { deep: true });

		this.$watch(() => this.display.sharedChannelization, (enabled: boolean) => {
			this.saveSetting();
			this.applySharedChannelization();
		});

		this.$watch('locks', () => {
			if (this.remoteMode === 'host' && this._webrtc) {
				this._webrtc.sendCommand({ type: 'sync', locks: this.locks });
			}
			this.saveSetting();
		}, { deep: true });
	},
	mounted(this: any) {
		mountCanvas.call(this);
		this._disposeHeaderTools = mountHeaderTools(this);
	},
	beforeUnmount(this: any) {
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
