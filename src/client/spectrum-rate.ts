export function normalizeSpectrumFps(value: unknown): number {
	return value === 20 || value === 30 || value === 60 ? value : 20;
}

export function spectrumSmoothingAlpha(elapsedMs: number): number {
	return 1 - Math.pow(1 - 0.6, Math.max(0, elapsedMs) / 50);
}

export class WaterfallClock {
	private lastTime: number | undefined;
	private fraction = 0;

	advance(now: number): { rows: number; fraction: number } {
		if (this.lastTime === undefined) {
			this.lastTime = now;
			return { rows: 1, fraction: 0 };
		}
		const elapsed = Math.max(0, now - this.lastTime);
		this.lastTime = now;
		if (elapsed > 1000) {
			this.fraction = 0;
			return { rows: 1, fraction: 0 };
		}
		const progress = this.fraction + elapsed / 50;
		const rows = Math.floor(progress + 1e-9);
		this.fraction = Math.max(0, progress - rows);
		return { rows, fraction: this.fraction };
	}
}
