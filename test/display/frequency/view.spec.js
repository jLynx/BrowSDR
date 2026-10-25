import { describe, expect, it, vi } from 'vitest';
import { frequencyView } from '@/display/frequency-view';
import { zoomMethods } from '@/app/display/zoom';
import { vfoMethods } from '@/app/radio/vfo';
import { uiHelperMethods } from '@/app/core/ui-helpers';
import { formatFrequencyLabel, formatFrequencyMhz } from '@/display/frequency-format';

describe('physical frequency bounds', () => {
	const radio = { centerFreq: 0.2, sampleRate: 3_200_000, frequencyShift: 0 };
	it('crops the negative FFT bins without relabeling or shifting the remaining data', () => {
		const view = frequencyView(radio, { zoomOffset: 0, zoomScale: 1 });
		expect(view.minFreq).toBe(0);
		expect(view.maxFreq).toBeCloseTo(1.8);
		expect(view.zoomOffset).toBeCloseTo(1.4 / 3.2);
		expect(view.zoomScale).toBeCloseTo(3.2 / 1.8);
		// The original center FFT bin still represents 200 kHz after the crop.
		expect((0.5 - view.zoomOffset) * view.zoomScale).toBeCloseTo(0.2 / 1.8);
	});
	it('uses the same crop in the waterfall renderer and clamps panning at zero', () => {
		const receiver = { radio, view: { zoomOffset: -1, zoomScale: 4 }, _waterfallEngine: { setZoom: vi.fn() } };
		zoomMethods.applyZoomToEngine.call(receiver);
		expect(frequencyView(radio, receiver.view).minFreq).toBe(0);
		expect(receiver._waterfallEngine.setZoom).toHaveBeenCalledWith(receiver.view.zoomOffset, receiver.view.zoomScale);
	});
	it('cannot zoom out into negative frequencies', () => {
		const receiver = {
			radio,
			view: { zoomOffset: 0.4375, zoomScale: 3.2 / 1.8 },
			applyZoomToEngine() {
				zoomMethods.applyZoomToEngine.call(this);
			},
		};
		zoomMethods.handleWheelZoom.call(receiver, { preventDefault() {}, deltaY: 1, clientX: 0 }, { left: 0, width: 1000 });
		expect(frequencyView(radio, receiver.view).minFreq).toBe(0);
		expect(frequencyView(radio, receiver.view).maxFreq).toBeCloseTo(1.8);
	});
	it('preserves ordinary views and clips RF at zero when an upconverter is used', () => {
		const view = { zoomOffset: 0.25, zoomScale: 2 };
		expect(frequencyView({ centerFreq: 100, sampleRate: 20_000_000 }, view)).toEqual({ ...view, minFreq: 95, maxFreq: 105 });
		expect(frequencyView({ ...radio, frequencyShift: -125 }, { zoomOffset: 0, zoomScale: 1 }).minFreq).toBe(0);
		expect(
			frequencyView({ centerFreq: 1168.2, sampleRate: 3_200_000, frequencyShift: 1168 }, { zoomOffset: 0, zoomScale: 1 }).minFreq,
		).toBe(1168);
	});
	it('rejects negative VFO input instead of treating it as kHz', () => {
		const receiver = {
			radio,
			vfos: [{ freq: 0.859, displayFreq: '-0.859' }],
			formatFreq: uiHelperMethods.formatFreq,
			showMsg: vi.fn(),
			updateBackendVfoParams: vi.fn(),
		};
		vfoMethods.validateAndApplyVfoFreq.call(receiver, 0, -0.859);
		expect(receiver.vfos[0]).toEqual({ freq: 0.859, displayFreq: '000.859000' });
		expect(receiver.updateBackendVfoParams).not.toHaveBeenCalled();
		expect(vfoMethods.isFreqInBandwidth.call(receiver, -0.859)).toBe(false);
	});
	it('formats low frequencies in MHz and keeps signs ahead of padding', () => {
		expect(formatFrequencyLabel(0.859)).toBe('0.859000 MHz');
		expect(formatFrequencyLabel(1)).toBe('1.000000 MHz');
		expect(formatFrequencyMhz(-0.859)).toBe('-000.859000');
	});
	it('keeps an invalid or empty sample span finite', () => {
		expect(frequencyView({ ...radio, sampleRate: 0 }, { zoomScale: 1, zoomOffset: 0 })).toEqual({
			zoomScale: 1,
			zoomOffset: 0,
			minFreq: 0,
			maxFreq: 0,
		});
	});
});
