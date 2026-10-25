import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, watch } from 'vue';
import { watchRadioTuning } from '@/app/radio/tuning';

let receiver;
const stops = [];
function setup() {
	vi.useFakeTimers();
	receiver = {
		radio: reactive({ centerFreq: 100, frequencyShift: 0 }),
		view: {},
		ble: {},
		_cleanup: [],
		running: true,
		remoteMode: 'none',
		backend: { setFrequency: vi.fn().mockResolvedValue(undefined) },
		applyZoomToEngine: vi.fn(),
		saveSetting: vi.fn(),
		showMsg: vi.fn(),
		togglePlay: vi.fn(),
		$watch(source, callback) {
			const stop = watch(source, callback);
			stops.push(stop);
			return stop;
		},
	};
	watchRadioTuning(receiver);
	return receiver;
}
async function settle() {
	await nextTick();
	await vi.advanceTimersByTimeAsync(200);
	await nextTick();
}
afterEach(() => {
	stops.splice(0).forEach((stop) => stop());
	receiver?._cleanup.forEach((cleanup) => cleanup());
	vi.useRealTimers();
});

describe('hardware tuning confirmation', () => {
	it('restores the last successful center in the UI and hardware after an unsupported tune', async () => {
		const receiver = setup();
		receiver.radio.centerFreq = 131.55;
		await settle();
		receiver.backend.setFrequency.mockRejectedValueOnce(new Error('SX: cannot tune to 0.200 MHz'));
		receiver.radio.centerFreq = 0.2;
		await settle();
		expect(receiver.radio.centerFreq).toBe(131.55);
		expect(receiver.backend.setFrequency).toHaveBeenLastCalledWith(131.55, 0);
		expect(receiver.showMsg).toHaveBeenCalledWith(expect.stringContaining('Restored the previous frequency'));
	});
	it('applies a changed center and upconverter shift as one tuning request', async () => {
		const receiver = setup();
		Object.assign(receiver.radio, { centerFreq: 0.859, frequencyShift: -125 });
		await settle();
		expect(receiver.backend.setFrequency).toHaveBeenCalledExactlyOnceWith(0.859, -125);
	});
	it.each([-0.859, NaN, Infinity])('does not send invalid RF tuning requests (%s) to hardware', async (frequency) => {
		const receiver = setup();
		receiver.radio.centerFreq = frequency;
		await settle();
		expect(receiver.radio.centerFreq).toBe(100);
		expect(receiver.backend.setFrequency).toHaveBeenCalledExactlyOnceWith(100, 0);
	});
	it('does not let a rejected older request replace a newer frequency', async () => {
		const receiver = setup();
		let reject;
		receiver.backend.setFrequency.mockImplementationOnce(
			() =>
				new Promise((_, failure) => {
					reject = failure;
				}),
		);
		receiver.radio.centerFreq = 0.2;
		await settle();
		receiver.radio.centerFreq = 106.5;
		await nextTick();
		reject(new Error('Cannot tune'));
		await settle();
		expect(receiver.radio.centerFreq).toBe(106.5);
		expect(receiver.backend.setFrequency).toHaveBeenLastCalledWith(106.5, 0);
		expect(receiver.showMsg).not.toHaveBeenCalled();
	});
	it('keeps the last accepted hardware tuning when selecting a frequency while stopped', async () => {
		const receiver = setup();
		receiver.running = false;
		receiver.radio.centerFreq = 0.2;
		await settle();
		expect(receiver.radio.centerFreq).toBe(0.2);
		expect(receiver._confirmedTuning.centerFreq).toBe(100);
		expect(receiver.backend.setFrequency).not.toHaveBeenCalled();
	});
});
