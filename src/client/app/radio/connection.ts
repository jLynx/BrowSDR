import { markRaw } from 'vue';
import type { PairedSdr } from './types';
import { errorMessage, errorName } from '@/platform/errors';
import type { AppInstance } from '@/app/core/receiver.types';
import * as Comlink from 'comlink';
import { getAllCatalogFilters, lookupDevice } from '@/radio/device-catalog';
import { localUsbIssue } from '@/platform/browser-capabilities';

export const connectionMethods = {
	async connect(this: AppInstance) {
		if (this.remoteMode === 'client' || this.workspace?.mode === 'client') return;
		this.usbCapabilityIssue = localUsbIssue();
		if (this.usbCapabilityIssue) {
			this.devicePicker.devices = [];
			this.devicePicker.show = true;
			return;
		}
		if (!this.backend) return;
		this._initAudioCtx(); // create AudioContext within user gesture

		// Get already-paired USB devices and filter to recognized SDR devices
		let allPaired: USBDevice[];
		try {
			allPaired = await navigator.usb.getDevices();
		} catch (error) {
			this.showMsg('USB access failed: ' + errorMessage(error));
			return;
		}
		const sdrDevices: PairedSdr[] = [];
		for (const device of allPaired) {
			const driver = lookupDevice(device);
			if (driver && !this.workspace?.isDeviceConnected(device)) {
				sdrDevices.push({
					device: markRaw(device),
					driverName: driver.name,
					productName: device.productName || '',
					deviceNumber: allPaired.indexOf(device) + 1,
				});
			}
		}

		this.devicePicker.devices = sdrDevices;
		this.devicePicker.show = true;
	},

	async pairNewDevice(this: AppInstance) {
		if (this.remoteMode === 'client' || this.workspace?.mode === 'client') return;
		this.usbCapabilityIssue = localUsbIssue();
		if (this.usbCapabilityIssue) {
			this.devicePicker.show = true;
			return;
		}
		this.devicePicker.show = false;
		const device = await navigator.usb
			.requestDevice({
				filters: getAllCatalogFilters(),
			})
			.catch((error: unknown) => {
				if (errorName(error) !== 'NotFoundError') this.showMsg('USB access failed: ' + errorMessage(error));
				return null;
			});
		if (!device) return;
		await this.connectToDevice(device);
	},

	async connectToDevice(this: AppInstance, device: USBDevice) {
		this.devicePicker.show = false;
		if (this.workspace) return this.workspace.connectDevice(this, device);
		return this._connectToDevice(device);
	},
	async _connectToDevice(this: AppInstance, device: USBDevice, deviceIndex?: number) {
		this.devicePicker.show = false;
		this.showMsg('Connecting...');
		try {
			const ok = await this.backend.open({
				vendorId: device.vendorId,
				productId: device.productId,
				serialNumber: device.serialNumber,
				deviceIndex,
			});
			if (ok) {
				this.connected = true;
				const info = await this.backend.info();
				this.info.boardName = info.name;

				// Populate device capabilities for dynamic UI
				const caps = await this.backend.getDeviceCapabilities();
				this.deviceCapabilities = caps;
				if (caps) {
					// Initialize gains from device defaults
					const newGains: Record<string, number> = {};
					for (const gc of caps.gainControls) {
						const saved = this.gains[gc.name];
						newGains[gc.name] =
							caps.deviceType === 'limesdr' &&
							(gc.name === 'Antenna' || gc.name === 'RX Channel') &&
							Number.isInteger(saved) &&
							saved >= gc.min &&
							saved <= gc.max
								? saved
								: gc.default;
					}
					this.gains = newGains;

					// If current sample rate isn't in the device's supported list, pick the closest
					if (!caps.sampleRates.includes(this.radio.sampleRate)) {
						this.radio.sampleRate = caps.sampleRates[caps.sampleRates.length - 1];
					}
				}

				this.showMsg('Connected to ' + this.info.boardName);
				await this.startStream();
			} else {
				this.showMsg('Failed to open device.');
			}
		} catch (e) {
			this.showMsg('Connect Error: ' + errorMessage(e));
		}
	},

	async connectMock(this: AppInstance) {
		this.devicePicker.show = false;
		if (this.workspace) return this.workspace.connectDevice(this, 'mock');
		return this._connectMock();
	},
	async _connectMock(this: AppInstance) {
		if (!this.backend) return;
		this._initAudioCtx(); // create AudioContext within user gesture
		this.showMsg('Connecting Mock SDR...');
		try {
			const ok = await this.backend.open('mock');
			if (ok) {
				this.connected = true;
				const info = await this.backend.info();
				this.info.boardName = info.name;

				const caps = await this.backend.getDeviceCapabilities();
				this.deviceCapabilities = caps;
				if (caps) {
					const newGains: Record<string, number> = {};
					for (const gc of caps.gainControls) {
						newGains[gc.name] = gc.default;
					}
					this.gains = newGains;
				}

				this.showMsg('Connected to Mock SDR');
				await this.startStream();
			} else {
				this.showMsg('Failed to open Mock SDR.');
			}
		} catch (e) {
			this.showMsg('Mock Connect Error: ' + errorMessage(e));
		}
	},
	async disconnect(this: AppInstance) {
		if (this.workspace) {
			if (this.remoteMode === 'client') return this.workspace.disconnectRemote();
			return this.workspace.removeReceiver(this.receiverId);
		}
		return this._disconnectReceiver();
	},
	async _disconnectReceiver(this: AppInstance) {
		if (this.autoGain.active) this.cancelAutoGain();
		if (this.workspace) {
			this.stopWhisper();
			this._receiverTransport = this._webrtc = null;
			this.remoteMode = 'none';
			if (this.running) await this.togglePlay();
			await this.backend.close();
			this.connected = false;
			return;
		}
		if (this.remoteMode === 'client' && this._webrtc) {
			this._webrtc.close();
			this._webrtc = null;
			this.remoteMode = 'none';
			if (this.running) await this.togglePlay();
			this.connected = false;
			this.deviceCapabilities = null;
			this.showMsg('Disconnected from remote device');
			// Clear the URL
			window.history.replaceState({}, document.title, '/');
			return;
		}

		if (this.remoteMode === 'host' && this._webrtc) {
			this._webrtc.close();
			this._webrtc = null;
			this.remoteMode = 'none';
			this.remoteClients = [];
			this.showRemoteClientsDialog = false;
			this.showMsg('Remote sharing stopped');
		}

		if (this.running) await this.togglePlay();
		await this.backend.close();
		this.connected = false;
		this.deviceCapabilities = null;
		this.showMsg('Disconnected');
	},
	_releaseWakeLock(this: AppInstance) {
		if (this._wakeLock) {
			this._wakeLock.release().catch(() => {});
			this._wakeLock = null;
		}
	},
	async _acquireWakeLock(this: AppInstance) {
		if ('wakeLock' in navigator) {
			try {
				this._wakeLock = await navigator.wakeLock.request('screen');
			} catch (_) {
				/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
			}
		}
	},
	async togglePlay(this: AppInstance, isRestart = false) {
		if (this._playChanging) return;
		this._playChanging = true;
		try {
			await this._togglePlay(isRestart);
		} finally {
			this._playChanging = false;
		}
	},
	async _togglePlay(this: AppInstance, isRestart = false) {
		if (this.running) {
			if (this.autoGain.active) this.cancelAutoGain();
			await this.backend.stopRx();
			this.running = false;
			if (this._statsTimer) {
				clearInterval(this._statsTimer);
				this._statsTimer = null;
			}
			this.dspStats = null;
			if (this._mediaAudioEl) {
				this._mediaAudioEl.pause();
				if (this._mediaSource && this._mediaSource.readyState === 'open') {
					try {
						this._mediaSource.endOfStream();
					} catch (_) {
						/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
					}
				}
				this._mediaSource = null;
				this._silentMp3Data = null;
				this._mediaAudioEl.src = '';
				this._mediaAudioEl.remove();
				this._mediaAudioEl = null;
			}
			if (this.audioCtx) {
				try {
					await this.audioCtx.close();
				} catch (_) {
					/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
				}
				this.audioCtx = null;
				this.gainNode = null;
			}
			this._releaseWakeLock();
			if (this.workspace) this.workspace.updateMediaSession();
			else if ('mediaSession' in navigator) {
				navigator.mediaSession.playbackState = 'paused';
				navigator.mediaSession.setActionHandler('play', null);
				navigator.mediaSession.setActionHandler('pause', null);
				navigator.mediaSession.setActionHandler('stop', null);
			}
		} else {
			await this.startStream(isRestart);
		}
	},
	async startStream(this: AppInstance, isRestart = false) {
		if (this.running) return;
		this._initAudioCtx();

		this.initCanvas();

		// Set running=true synchronously so drawSpectrum() isn't blocked by the
		// `if (!this.running)` guard while we're awaiting startRxStream(). For
		// remote clients, WebRTC FFT chunks can arrive before that await resolves.
		this.running = true;

		const opts = {
			centerFreq: this.radio.centerFreq,
			frequencyShift: this.radio.frequencyShift,
			sampleRate: this.radio.sampleRate,
			fftSize: this.radio.fftSize,
			spectrumFps: this.display.spectrumFps,
			sharedChannelization: this.display.sharedChannelization,
			whisperEnabled: this.whisper.active && this.whisper.status === 'ready',
			gains: { ...this.gains },
		};

		try {
			await this.backend.startRxStream(
				opts,
				Comlink.proxy((spectrumData: Float32Array) => this.drawSpectrum(spectrumData)),
				Comlink.proxy((audioSamples: Float32Array, channels: 1 | 2 = 1) => this.playAudio(audioSamples, channels)),
				Comlink.proxy((vfoIndex: number, freq: number, samples: Float32Array) => this._feedWhisperVfo(vfoIndex, freq, samples)),
				Comlink.proxy((vfoIndex: number, freq: number, msg: Parameters<AppInstance['_onPocsagMessage']>[2]) =>
					this._onPocsagMessage(vfoIndex, freq, msg),
				),
				Comlink.proxy((vfoIndex: number, freq: number, msg: Parameters<AppInstance['_onRdsMessage']>[2]) =>
					this._onRdsMessage(vfoIndex, freq, msg),
				),
				Comlink.proxy((vfoIndex: number, status: Parameters<AppInstance['_onDsdStatus']>[1]) => this._onDsdStatus(vfoIndex, status)),
				Comlink.proxy((vfoIndex: number, freq: number, msg: Parameters<AppInstance['_onRtl433Message']>[2]) =>
					this._onRtl433Message(vfoIndex, freq, msg),
				),
			);
		} catch (e) {
			console.error('Error starting RX stream:', e);
			try {
				await this.backend.stopRx();
			} catch {
				/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
			}
			this.showMsg('Error starting stream: ' + errorMessage(e));
			this.running = false;
			return;
		}

		startReceiverStatsPolling.call(this);

		await this._acquireWakeLock();
		if (this.workspace) this.workspace.updateMediaSession();
		else if ('mediaSession' in navigator) {
			navigator.mediaSession.metadata = new MediaMetadata({
				title: 'BrowSDR',
				artist: 'Receiving',
				artwork: [
					{ src: '/icon-96.png', sizes: '96x96', type: 'image/png' },
					{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
				],
			});
			navigator.mediaSession.playbackState = 'playing';
			// Action handlers are REQUIRED for Chrome on Android to show the media notification.
			// Without at least play+pause registered, the notification never appears.
			navigator.mediaSession.setActionHandler('play', () => {
				if (this._mediaAudioEl) this._mediaAudioEl.play().catch(() => {});
				if (this.audioCtx?.state === 'suspended') this.audioCtx.resume().catch(() => {});
				navigator.mediaSession.playbackState = 'playing';
			});
			navigator.mediaSession.setActionHandler('pause', () => {
				// Don't actually pause — just keep showing the notification (user can stop from the UI)
				navigator.mediaSession.playbackState = 'playing';
			});
			navigator.mediaSession.setActionHandler('stop', () => {
				Promise.resolve(this.togglePlay()).catch((error: unknown) => console.error(error));
			});
		}

		// Add additional VFOs beyond the first (which is created by default in the worker).
		// In client mode, notify the host via WebRTC instead of calling the mock backend.
		if (this.remoteMode === 'client' && this._receiverTransport) this._webrtc?.sendCommand({ type: 'resetRemoteVfos' });
		for (let i = 1; i < this.vfos.length; i++) {
			if (this.remoteMode === 'client' && this._webrtc) {
				this._webrtc?.sendCommand({ type: 'addRemoteVfo' });
			} else {
				await this.backend.addVfo();
			}
		}

		// Enable first VFO by default only on initial start (not restart).
		// During a restart (e.g. center freq change), preserve existing mute states.
		if (!isRestart) {
			this.vfos[0].enabled = true;
		}
		this.toggleVfoCheckbox(0);

		// Send all VFO params to worker (or host in client mode)
		for (let i = 0; i < this.vfos.length; i++) {
			this.updateBackendVfoParams(i);
		}
	},
};

function startReceiverStatsPolling(this: AppInstance) {
	this._statsTimer = setInterval(() => {
		(async () => {
			if (this.backend && this.running) {
				// Remote clients receive squelch state via WebRTC 'squelchState'
				// commands (see remote.ts). Skip local polling so the host-provided
				// data isn't overwritten with stale all-false values from the mock backend.
				if (this.remoteMode === 'client') return;
				const stats = await this.backend.getDspStats();
				if (!this.running) return;
				this.dspStats = stats;
				if (this.dspStats && this.dspStats.squelchOpen) {
					const now = Date.now();
					const squelchStates = this.dspStats.squelchOpen.slice();
					for (let i = 0; i < squelchStates.length; i++) {
						if (squelchStates[i]) {
							this.vfoSquelchHangUntil[i] = now + 1000;
						} else if (this.vfoSquelchHangUntil[i] && now < this.vfoSquelchHangUntil[i]) {
							squelchStates[i] = true;
						}
					}
					this.vfoSquelchOpen = squelchStates;
					// ── Frequency activity tracker ──
					// Uses pre-hang squelch states for analog, decoded voice playback for DSD.
					updateReceiverActivity.call(this, now);
				}
				// ── Auto-squelch sample collection ──
				if (this.dspStats && this.dspStats.squelchDb) {
					for (let i = 0; i < this.dspStats.squelchDb.length; i++) {
						if (this.autoSquelchActive[i] && this.autoSquelchSamples[i]) {
							this.autoSquelchSamples[i].push(this.dspStats.squelchDb[i]);
						}
					}
				}
			}
		})().catch((error: unknown) => console.error(error));
	}, 500);
}

function updateReceiverActivity(this: AppInstance, now: number) {
	const rawOpen = this.dspStats?.squelchOpen ?? [];
	for (let i = 0; i < rawOpen.length; i++) {
		if (!this.vfoActivityStats[i]) {
			this.vfoActivityStats[i] = { count: 0, totalMs: 0, squelchOpenSince: null };
		}
		const stat = this.vfoActivityStats[i];
		// Only track activity for VFOs that are not muted
		if (rawOpen[i] && this.vfos[i]?.enabled) {
			if (stat.squelchOpenSince === null) {
				// Squelch just opened – start a new event
				stat.squelchOpenSince = now;
				stat.count++;
			}
		} else {
			if (stat.squelchOpenSince !== null) {
				// Squelch just closed – accumulate duration
				stat.totalMs += now - stat.squelchOpenSince;
				stat.squelchOpenSince = null;
			}
		}
	}
	// Bump reactive tick so sortedVfoActivity recomputes
	this.activityNow = now;
}
