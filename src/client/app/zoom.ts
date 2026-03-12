import type { AppInstance } from './types';

export const zoomMethods = {
	handleWheelZoom(this: AppInstance, e: WheelEvent, rect: DOMRect) {
		e.preventDefault();

		const zoomSensitivity = 0.1;
		const zoomDir = e.deltaY < 0 ? 1 : -1;
		const newScale = Math.max(1.0, Math.min(100.0, this.view.zoomScale * (1 + (zoomDir * zoomSensitivity))));

		// Calculate where the mouse is relative to the current view
		const mouseX = e.clientX - rect.left;
		const p = mouseX / rect.width;

		// Calculate the absolute normalized coordinate of the mouse
		const absNormTarget = this.view.zoomOffset + (p / this.view.zoomScale);

		// Calculate new offset to keep the absolute target under the mouse
		let newOffset = absNormTarget - (p / newScale);

		// Clamp offset
		const maxOffset = 1.0 - (1.0 / newScale);
		if (newOffset < 0) newOffset = 0;
		if (newOffset > maxOffset) newOffset = maxOffset;

		this.view.zoomScale = newScale;
		this.view.zoomOffset = newOffset;

		this.applyZoomToEngine();
	},
	applyZoomToEngine(this: AppInstance) {
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
