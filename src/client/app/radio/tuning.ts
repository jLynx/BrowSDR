import type { AppInstance } from '@/app/core/receiver.types';
import { isValidDisplayFrequencyMhz } from '@/radio/frequency-shift';
import { errorMessage } from '@/platform/errors';

/** Apply center/shift together and retain the last tuning accepted by the hardware. */
export function watchRadioTuning(receiver: AppInstance): void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pending = Promise.resolve();
	let disposed = false;
	receiver._confirmedTuning = { centerFreq: receiver.radio.centerFreq, frequencyShift: receiver.radio.frequencyShift };
	const current = (centerFreq: number, frequencyShift: number) =>
		Object.is(receiver.radio.centerFreq, centerFreq) && Object.is(receiver.radio.frequencyShift, frequencyShift);
	const sync = () => {
		receiver.saveSetting();
		if (receiver.remoteMode === 'host') {
			receiver._webrtc?.sendCommand({ type: 'sync', radio: receiver.radio, gains: receiver.gains, locks: receiver.locks });
		}
	};
	receiver._cleanup.push(() => {
		disposed = true;
		if (timer) clearTimeout(timer);
	});
	receiver.$watch(
		() => [receiver.radio.centerFreq, receiver.radio.frequencyShift],
		([centerFreq, frequencyShift], [previousCenter]) => {
			if (timer) clearTimeout(timer);
			if (centerFreq !== previousCenter) {
				if (receiver.ble.tuning) return;
				if (receiver.ble.scanning) receiver.stopBleScan();
				receiver.view.zoomScale = 1;
				receiver.view.zoomOffset = 0;
			}
			receiver.applyZoomToEngine();
			if (receiver.remoteMode === 'client') {
				if (!receiver._applyingSync && centerFreq !== previousCenter) {
					receiver._webrtc?.sendCommand({ type: 'requestChange', target: 'radio', property: 'centerFreq', value: centerFreq });
				}
				return;
			}
			const confirmed = receiver._confirmedTuning!;
			if (centerFreq === confirmed.centerFreq && frequencyShift === confirmed.frequencyShift) return;
			timer = setTimeout(() => {
				timer = null;
				pending = pending.then(async () => {
					if (disposed || !current(centerFreq, frequencyShift)) return;
					try {
						if (!Number.isFinite(frequencyShift) || !isValidDisplayFrequencyMhz(centerFreq, frequencyShift)) {
							throw new RangeError('RF and SDR frequencies must be finite and non-negative');
						}
						if (receiver.running && receiver.backend) {
							await receiver.backend.setFrequency(centerFreq, frequencyShift);
							receiver._confirmedTuning = { centerFreq, frequencyShift };
						}
						if (disposed) return;
						if (current(centerFreq, frequencyShift)) sync();
					} catch (error) {
						if (disposed || !current(centerFreq, frequencyShift)) return;
						const previous = receiver._confirmedTuning!;
						Object.assign(receiver.radio, previous);
						// A rejected PLL retune can alter registers before failing. Restore hardware too.
						if (receiver.running && receiver.backend) {
							try {
								await receiver.backend.setFrequency(previous.centerFreq, previous.frequencyShift);
							} catch {
								await receiver.togglePlay();
							}
						}
						sync();
						receiver.showMsg('Unable to tune: ' + errorMessage(error) + '. Restored the previous frequency.');
					}
				});
			}, 200);
		},
	);
}
