import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/worker/runtime/wasm-init', () => ({
	FFT: vi.fn(() => {
		throw new Error('Diagnostic created FFT');
	}),
}));
import { startRxStream } from '@/worker/streams/rx-stream';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('USB-only receive pipeline', () => {
	it('configures the device, bypasses DSP workers/FFT/audio, and reports raw reception independently', async () => {
		vi.useFakeTimers();
		let now = 0;
		vi.stubGlobal('performance', { now: () => now });
		const worker = vi.fn(() => {
			throw new Error('Diagnostic created a DSP worker');
		});
		vi.stubGlobal('Worker', worker);
		const source = {
			usbDiagnosticMode: 1,
			usbTransferCount: 0,
			usbReceivedSamples: 0,
			usbLastTransferBytes: 393216,
			sourceGapCount: 0,
			sourceMissingSamples: 0,
		};
		const device = {
			deviceType: 'limesdr',
			setSampleRate: vi.fn(),
			setFrequency: vi.fn(),
			setGains: vi.fn(),
			startRx: vi.fn(),
			getRxStreamStats: () => source,
		};
		const backend = { device, setWhisperEnabled: vi.fn(), _reinitRemoteClientWorkers: vi.fn() };
		const spectrum = vi.fn();
		const audio = vi.fn();
		await startRxStream(
			backend,
			{ centerFreq: 106.2, sampleRate: 61440000, fftSize: 65536, gains: { 'Receive Mode': 1, 'USB Format': 1 } },
			spectrum,
			audio,
			null,
			null,
		);
		expect(device.setGains).toHaveBeenCalledWith({ 'Receive Mode': 1, 'USB Format': 1 });
		expect(device.startRx).toHaveBeenCalledOnce();
		expect(worker).not.toHaveBeenCalled();
		expect(backend.dspWorkers).toEqual([]);
		expect(backend._reinitRemoteClientWorkers).not.toHaveBeenCalled();
		Object.assign(source, { usbTransferCount: 235, usbReceivedSamples: 235 * 130560, sourceGapCount: 2, sourceMissingSamples: 1360 });
		now = 500;
		vi.advanceTimersByTime(500);
		expect(backend._perf.report).toMatchObject({
			usbFps: 470,
			inputRate: 61363200,
			chunkSize: 393216,
			audioFps: 0,
			audioRate: 0,
			msgRate: 0,
			sourceGapCount: 2,
			sourceMissingSamples: 1360,
		});
		Object.assign(source, { usbTransferCount: 470, usbReceivedSamples: 470 * 130560 });
		now = 1000;
		vi.advanceTimersByTime(500);
		expect(backend._perf.report.usbFps).toBe(470);
		expect(spectrum).not.toHaveBeenCalled();
		expect(audio).not.toHaveBeenCalled();
		clearInterval(backend._perfInterval);
	});
});
