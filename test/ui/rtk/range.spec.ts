import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createAppData } from '@/app/core/state';
import type { AppInstance } from '@/app/core/receiver.types';
import { fitDiscoveryRange } from '@/app/decoders/rtk/discovery/range';

function receiverFixture() {
	const receiver = {
		...createAppData(),
		connected: true,
		running: true,
		deviceCapabilities: {
			deviceType: 'limesdr',
			sampleRates: [61440000, 20000000, 10000000, 2000000],
			gainControls: [],
			sampleFormat: 'int16',
		},
		backend: { setFrequency: vi.fn(async () => {}) },
		$nextTick: nextTick,
		applyZoomToEngine: vi.fn(),
		updateAllBackendVfoParams: vi.fn(),
		saveSetting: vi.fn(),
		togglePlay: vi.fn(async () => {
			receiver.running = !receiver.running;
		}),
	} as unknown as AppInstance;
	Object.assign(receiver.radio, { centerFreq: 915.87, sampleRate: 20000000 });
	return receiver;
}

describe('RTK discovery receive band', () => {
	it('retains a rate that exactly fits decimal limits and filter margins', async () => {
		const receiver = receiverFixture();
		await fitDiscoveryRange(receiver, 906.17, 925.57, true);
		expect(receiver.radio.sampleRate).toBe(20000000);
		expect(receiver.togglePlay).not.toHaveBeenCalled();
	});
	it('rejects a frequency shift that would tune the SDR below zero', async () => {
		const receiver = receiverFixture();
		receiver.radio.frequencyShift = 1000;
		await expect(fitDiscoveryRange(receiver, 915, 928, true)).rejects.toThrow('frequency shift');
		expect(receiver.backend.setFrequency).not.toHaveBeenCalled();
	});
	it('centers live reception without changing VFO frequencies, gains, or mute states', async () => {
		const receiver = receiverFixture();
		const vfos = structuredClone(receiver.vfos),
			gains = structuredClone(receiver.gains);
		await fitDiscoveryRange(receiver, 915, 928, true);
		expect(receiver.radio).toMatchObject({ centerFreq: 921.5, sampleRate: 20000000 });
		expect(receiver.backend.setFrequency).toHaveBeenCalledWith(921.5, 0);
		expect(receiver.togglePlay).not.toHaveBeenCalled();
		expect(receiver.vfos).toEqual(vfos);
		expect(receiver.gains).toEqual(gains);
		expect(receiver._confirmedTuning?.centerFreq).toBe(921.5);
	});
	it('widens to the smallest supported fitting rate and stops before tuning, then resumes', async () => {
		const receiver = receiverFixture();
		receiver.radio.sampleRate = 2000000;
		vi.mocked(receiver.backend.setFrequency).mockImplementation(async () => {
			expect(receiver.running).toBe(false);
		});
		await fitDiscoveryRange(receiver, 915, 928, true);
		expect(receiver.radio).toMatchObject({ centerFreq: 921.5, sampleRate: 20000000 });
		expect(receiver.togglePlay).toHaveBeenCalledTimes(2);
		expect(receiver.running).toBe(true);
	});
	it('prepares stopped reception without starting it', async () => {
		const receiver = receiverFixture();
		receiver.running = false;
		receiver.radio.sampleRate = 2000000;
		await fitDiscoveryRange(receiver, 915, 928, true);
		expect(receiver.radio.sampleRate).toBe(20000000);
		expect(receiver.running).toBe(false);
		expect(receiver.togglePlay).not.toHaveBeenCalled();
	});
	it.each([
		[928, 915],
		[899, 928],
		[915, 931],
		[NaN, 928],
	])('rejects invalid limits before tuning (%s–%s)', async (start, end) => {
		const receiver = receiverFixture();
		await expect(fitDiscoveryRange(receiver, start, end, true)).rejects.toThrow();
		expect(receiver.radio.centerFreq).toBe(915.87);
		expect(receiver.backend.setFrequency).not.toHaveBeenCalled();
	});
	it('rejects insufficient hardware bandwidth before interrupting reception', async () => {
		const receiver = receiverFixture();
		receiver.radio.sampleRate = 2000000;
		receiver.deviceCapabilities!.sampleRates = [2000000, 10000000];
		await expect(fitDiscoveryRange(receiver, 915, 928, true)).rejects.toThrow('13.60 MSPS');
		expect(receiver.togglePlay).not.toHaveBeenCalled();
		expect(receiver.backend.setFrequency).not.toHaveBeenCalled();
	});
	it('keeps a fitting recording fixed and rejects an out-of-band recording range', async () => {
		const receiver = receiverFixture();
		receiver.iqReplay = {} as NonNullable<AppInstance['iqReplay']>;
		receiver.radio.centerFreq = 923.118;
		await fitDiscoveryRange(receiver, 915, 928, true);
		expect(receiver.radio.centerFreq).toBe(923.118);
		expect(receiver.backend.setFrequency).not.toHaveBeenCalled();
		receiver.radio.sampleRate = 2000000;
		await expect(fitDiscoveryRange(receiver, 915, 928, true)).rejects.toThrow('recording');
		expect(receiver.radio.sampleRate).toBe(2000000);
	});
	it('keeps remote tuning fixed and requests a host adjustment for a range outside it', async () => {
		const receiver = receiverFixture();
		receiver.remoteMode = 'client';
		receiver.radio.centerFreq = 923.118;
		await fitDiscoveryRange(receiver, 915, 928, true);
		receiver.radio.sampleRate = 2000000;
		await expect(fitDiscoveryRange(receiver, 915, 928, true)).rejects.toThrow('host receiver');
		expect(receiver.backend.setFrequency).not.toHaveBeenCalled();
	});
	it('uses the received band without recentering it', async () => {
		const receiver = receiverFixture();
		receiver.radio.centerFreq = 923.118;
		receiver.radio.sampleRate = 2000000;
		await fitDiscoveryRange(receiver, 922.418, 923.818, false);
		expect(receiver.radio.centerFreq).toBe(923.118);
		expect(receiver.backend.setFrequency).not.toHaveBeenCalled();
	});
	it('restores previous tuning and running state after a failed PLL change', async () => {
		const receiver = receiverFixture();
		receiver.radio.sampleRate = 2000000;
		vi.mocked(receiver.backend.setFrequency).mockRejectedValueOnce(new Error('PLL failed'));
		await expect(fitDiscoveryRange(receiver, 915, 928, true)).rejects.toThrow('PLL failed');
		expect(receiver.radio).toMatchObject({ centerFreq: 915.87, sampleRate: 2000000 });
		expect(receiver.running).toBe(true);
		expect(receiver.backend.setFrequency).toHaveBeenLastCalledWith(915.87, 0);
	});
	it('restores the old rate if reception cannot start with the wider band', async () => {
		const receiver = receiverFixture();
		receiver.radio.sampleRate = 2000000;
		vi.mocked(receiver.togglePlay)
			.mockImplementationOnce(async () => {
				receiver.running = false;
			})
			.mockImplementationOnce(async () => {})
			.mockImplementationOnce(async () => {
				receiver.running = true;
			});
		await expect(fitDiscoveryRange(receiver, 915, 928, true)).rejects.toThrow('restart reception');
		expect(receiver.radio).toMatchObject({ centerFreq: 915.87, sampleRate: 2000000 });
		expect(receiver.running).toBe(true);
	});
});
