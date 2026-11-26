import type { AppInstance } from '@/app/core/receiver.types';
import { frequencyView } from '@/display/frequency-view';

/** Centre a frequency using the same minimum zoom as the active-audio shortcuts. */
export function focusSpectrumFrequency(receiver: AppInstance, frequencyMHz: number): void {
	const position = ((frequencyMHz - receiver.radio.centerFreq) * 1e6) / receiver.radio.sampleRate + 0.5;
	if (!Number.isFinite(position) || position < 0 || position > 1) return;
	const zoom = Math.max(receiver.view.zoomScale, 32);
	receiver.view.zoomScale = zoom;
	receiver.view.zoomOffset = Math.max(0, Math.min(1 - 1 / zoom, position - 0.5 / zoom));
	receiver.applyZoomToEngine();
}

/** Zoom around a position in the visible span (0 = left, 1 = right). */
export function zoomSpectrum(receiver: AppInstance, direction: -1 | 1, anchor: number): void {
	const bounds = frequencyView(receiver.radio, receiver.view);
	const newScale = Math.max(1, Math.min(100, bounds.zoomScale * (1 + direction * 0.1)));
	const target = bounds.zoomOffset + anchor / bounds.zoomScale;
	receiver.view.zoomScale = newScale;
	receiver.view.zoomOffset = Math.max(0, Math.min(1 - 1 / newScale, target - anchor / newScale));
	receiver.applyZoomToEngine();
}

export const zoomMethods = {
	toggleDisplayLock(this: AppInstance) {
		this.view.locked = !this.view.locked;
		this.view.autoLockDisabled = !this.view.locked;
	},
	handleWheelZoom(this: AppInstance, e: WheelEvent, rect: DOMRect) {
		e.preventDefault();
		if (rect.width > 0) zoomSpectrum(this, e.deltaY < 0 ? 1 : -1, (e.clientX - rect.left) / rect.width);
	},
	applyZoomToEngine(this: AppInstance) {
		const bounds = frequencyView(this.radio, this.view);
		this.view.zoomScale = bounds.zoomScale;
		this.view.zoomOffset = bounds.zoomOffset;
		if (this._waterfallEngine) {
			this._waterfallEngine.setZoom(this.view.zoomOffset, this.view.zoomScale);
			// Force an immediate repaint so the new zoom is visible without waiting for the next data frame
			if (this._lastSpectrumData && this._fftCtx) {
				this._zoomRepaint = true;
				this.drawSpectrum(this._lastSpectrumData);
				this._zoomRepaint = false;
			}
		}
	},
};
