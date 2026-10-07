import type { RxLevel } from '../sdr-device';

/** Measure signed 8-bit HackRF IQ before any filtering, demodulation or volume. */
export class HackRFRxLevel {
	private started = 0;
	private count = 0;
	private power = 0;
	private peak = 0;
	private clipped = 0;
	private phase = 0;
	private latest: RxLevel | null = null;

	reset(now = Date.now()): void {
		this.started = now;
		this.count = this.power = this.peak = this.clipped = this.phase = 0;
		this.latest = null;
	}
	observe(data: ArrayBufferView, now = Date.now()): void {
		if (!this.started) this.started = now;
		const iq = new Int8Array(data.buffer, data.byteOffset, data.byteLength);
		const pairs = Math.floor(iq.length / 2);
		// At most 1024 IQ pairs per transfer, with rotating positions to avoid
		// synchronizing to a periodic tone. No copy or mutation of USB samples.
		const stride = Math.max(1, Math.ceil(pairs / 1024));
		for (let pair = this.phase++ % stride; pair < pairs; pair += stride) {
			for (let component = 0; component < 2; component++) {
				const signed = iq[pair * 2 + component];
				const value = Math.abs(signed) / 128;
				this.power += value * value;
				this.peak = Math.max(this.peak, value);
				if (signed <= -127 || signed >= 126) this.clipped++;
				this.count++;
			}
		}
		if (now - this.started >= 250 && this.count) {
			this.latest = { timestamp: now, started: this.started, samples: this.count,
				rmsDbfs: 10 * Math.log10(Math.max(this.power / this.count, 1e-12)),
				peakDbfs: 20 * Math.log10(Math.max(this.peak, 1e-6)),
				clippedFraction: this.clipped / this.count };
			this.started = now;
			this.count = this.power = this.peak = this.clipped = 0;
		}
	}
	get level(): RxLevel | null { return this.latest; }
}
