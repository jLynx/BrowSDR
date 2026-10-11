import type { AppInstance } from '@/app/core/receiver.types';
import { displayRange } from '@/display/contrast';

export function updateContrast(this: AppInstance) {
	const range = displayRange(this.display);
	this._waterfallEngine?.setRange(range.minDB, range.maxDB);
	return range;
}

export function watchContrast(this: AppInstance) {
	this.$watch(
		() => [this.display.minDB, this.display.maxDB],
		() => {
			this.saveSetting();
			if (this._lastSpectrumData) {
				this._zoomRepaint = true;
				this.drawSpectrum(this._lastSpectrumData);
				this._zoomRepaint = false;
			}
		},
	);
}
