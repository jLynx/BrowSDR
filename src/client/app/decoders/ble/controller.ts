import type { AppInstance } from '@/app/core/receiver.types';
import type { BleMessage } from '@/worker/decoders/ble/types';
import { BLE_CHANNELS, BLE_RATE } from '@/worker/decoders/ble/packets';
import { mergeAdvertisements } from './devices';
import { errorMessage } from '@/platform/errors';

const timers = new WeakMap<AppInstance, ReturnType<typeof setTimeout>>();

export const bleMethods = {
	toggleBlePanel(this: AppInstance): void {
		this.ble.panelOpen = !this.ble.panelOpen;
	},
	_onBleMessage(this: AppInstance, index: number, freq: number, message: BleMessage): void {
		if (!this.running || !this.vfos[index]?.ble || this.vfos[index].freq !== freq) return;
		this.ble.status[index] = message.status;
		if (message.advertisements.length) this.ble.devices = mergeAdvertisements(this.ble.devices, message.advertisements);
	},
	clearBleDevices(this: AppInstance): void {
		this.ble.devices = [];
	},
	async tuneBleChannel(this: AppInstance, channel: number, index = this.activeVfoIndex): Promise<boolean> {
		const target = BLE_CHANNELS.find((item) => item.channel === channel);
		const vfo = this.vfos[index];
		if (!target || !vfo || this.ble.tuning) return false;
		if (this.remoteMode === 'client') {
			this.showMsg('Tune the host receiver to a BLE channel, then enable decoding.');
			return false;
		}
		// Center-frequency locks restrict remote clients; the local receiver owner can still tune.
		if (this.autoGain.active) {
			this.showMsg('Finish or cancel automatic gain adjustment before tuning BLE.');
			return false;
		}
		if (this.deviceCapabilities && !['hackrf', 'limesdr'].includes(this.deviceCapabilities.deviceType) && !this.radio.frequencyShift) {
			this.showMsg('BLE requires a receiver covering 2.4 GHz, such as HackRF or LimeSDR, or a suitable frequency converter.');
			return false;
		}
		if (this.radio.sampleRate < BLE_RATE) {
			this.showMsg('Select a sample rate of at least 2 MSPS before tuning BLE.');
			return false;
		}
		const decoding = vfo.ble;
		const scanVfo = this.ble.scanVfo;
		this.ble.tuning = true;
		this.ble.status[index] = null;
		vfo.ble = false;
		this.updateBackendVfoParams(index);
		try {
			if (this.running) await this.backend.setFrequency(target.frequency, this.radio.frequencyShift);
			this.ble.tuning = true;
			this.radio.centerFreq = target.frequency;
			vfo.freq = target.frequency;
			vfo.displayFreq = this.formatFreq(target.frequency);
			this.view.zoomScale = 1;
			this.view.zoomOffset = 0;
			this.applyZoomToEngine();
			await this.$nextTick();
		} finally {
			this.ble.tuning = false;
			vfo.ble = decoding && (!scanVfo || this.ble.scanVfo === scanVfo);
			this.updateAllBackendVfoParams();
			this.saveSetting();
			if (this.remoteMode === 'host') this._webrtc?.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains, locks: this.locks });
		}
		return true;
	},
	async startBleScan(this: AppInstance): Promise<void> {
		if (!this.running || this.remoteMode === 'client' || this.ble.tuning || this.ble.scanning) return;
		const vfo = this.vfos[this.activeVfoIndex];
		if (!vfo) return;
		this.ble.message = '';
		this.ble.scanning = true;
		this.ble.scanVfo = vfo;
		try {
			const tuned = await this.tuneBleChannel(37);
			if (!this.ble.scanning) return;
			if (!tuned || this.radio.centerFreq !== 2402 || vfo.freq !== 2402 || this.autoGain.active) {
				this.stopBleScan();
				return;
			}
			vfo.enabled = false;
			vfo.ble = true;
			this.updateBackendVfoParams(this.vfos.indexOf(vfo));
			schedule(this, 0);
		} catch (error) {
			this.ble.message = errorMessage(error);
			this.stopBleScan();
		}
	},
	stopBleScan(this: AppInstance): void {
		const timer = timers.get(this);
		if (timer) clearTimeout(timer);
		timers.delete(this);
		this.ble.scanning = false;
		if (this.ble.scanVfo) {
			const index = this.vfos.findIndex((vfo) => vfo === this.ble.scanVfo);
			this.ble.scanVfo.ble = false;
			if (index >= 0) this.updateBackendVfoParams(index);
		}
		this.ble.scanVfo = null;
	},
};

function schedule(receiver: AppInstance, channelIndex: number): void {
	const vfo = receiver.ble.scanVfo;
	timers.set(
		receiver,
		setTimeout(() => {
			void (async () => {
				if (!receiver.ble.scanning) return;
				const index = vfo ? receiver.vfos.findIndex((item) => item === vfo) : -1;
				if (
					!receiver.running ||
					receiver._disposed ||
					receiver.remoteMode === 'client' ||
					index < 0 ||
					!vfo?.ble ||
					receiver.autoGain.active ||
					vfo.freq !== BLE_CHANNELS[channelIndex].frequency ||
					receiver.radio.centerFreq !== vfo.freq
				) {
					receiver.stopBleScan();
					return;
				}
				const next = (channelIndex + 1) % 3;
				try {
					const tuned = await receiver.tuneBleChannel(BLE_CHANNELS[next].channel, index);
					if (!tuned) {
						receiver.stopBleScan();
						return;
					}
					if (receiver.ble.scanning && receiver.running) schedule(receiver, next);
				} catch (error) {
					receiver.ble.message = errorMessage(error);
					receiver.stopBleScan();
				}
			})();
		}, 1000),
	);
}
