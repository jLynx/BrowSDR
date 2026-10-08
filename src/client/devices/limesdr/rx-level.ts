import type { RxLevel } from '../../radio/sdr-device';

/** Sample the original 12-bit ADC words before the driver reduces them to int8. */
export class LimeRxLevel {
	private started = 0;
	private count = 0;
	private power = 0;
	private peak = 0;
	private clipped = 0;
	private phase = 0;
	private latest: RxLevel | null = null;

	reset(now = Date.now()): void {
		this.started = now;
		this.count = this.power = this.peak = this.clipped = 0;
		this.latest = null;
	}
	observe(data: DataView, now = Date.now()): void {
		if (!this.started) this.started = now;
		for (let packet = 0; packet + 4096 <= data.byteLength; packet += 4096) {
			// Rotate the sampled positions to avoid locking onto a periodic tone.
			for (let sample = 0; sample < 4; sample++) {
				const offset = packet + 16 + ((this.phase++ * 251) % 1020) * 4;
				for (let component = 0; component < 2; component++) {
					const value = Math.abs(data.getInt16(offset + component * 2, true)) / 32768;
					this.power += value * value;
					this.peak = Math.max(this.peak, value);
					if (value >= 0.98) this.clipped++;
					this.count++;
				}
			}
		}
		if (now - this.started >= 250 && this.count) {
			this.latest = {
				timestamp: now,
				started: this.started,
				samples: this.count,
				rmsDbfs: 10 * Math.log10(Math.max(this.power / this.count, 1e-12)),
				peakDbfs: 20 * Math.log10(Math.max(this.peak, 1e-6)),
				clippedFraction: this.clipped / this.count,
			};
			this.started = now;
			this.count = this.power = this.peak = this.clipped = 0;
		}
	}
	get level(): RxLevel | null {
		return this.latest;
	}
}
