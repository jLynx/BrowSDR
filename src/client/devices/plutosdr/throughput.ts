/** Received rate below this fraction of the configured rate means the device dropped samples. */
const SHORTFALL_RATIO = 0.99;

function msps(rate: number): string {
	return (rate / 1e6).toFixed(2);
}

/**
 * Receive-rate check for PlutoSDR streams. IIO buffers carry no sample
 * counters, so drops show up only as a shortfall against the configured
 * rate: the device's DMA pauses while all of its kernel buffers are full.
 */
export class PlutoThroughput {
	private windowStart: number | null = null;
	private samples = 0;
	private longestWait = 0;
	private longestProcessing = 0;

	constructor(
		private readonly sampleRate: number,
		private readonly report: (summary: string, shortfall: boolean) => void,
		private readonly windowMs = 10000,
	) {}

	/** Record one delivered block: time spent waiting for its reply, then processing it. */
	block(samples: number, waitMs: number, processingMs: number, now = performance.now()): void {
		// The first block starts the clock; its samples were captured before it.
		if (this.windowStart === null) {
			this.windowStart = now;
			return;
		}
		this.samples += samples;
		this.longestWait = Math.max(this.longestWait, waitMs);
		this.longestProcessing = Math.max(this.longestProcessing, processingMs);
		const elapsed = now - this.windowStart;
		if (elapsed < this.windowMs) return;
		const rate = (this.samples * 1000) / elapsed;
		const percent = ((100 * rate) / this.sampleRate).toFixed(1);
		this.report(
			`PlutoSDR: received ${msps(rate)} of ${msps(this.sampleRate)} MSPS (${percent}%); ` +
				`longest wait for USB ${this.longestWait.toFixed(1)} ms, longest processing ${this.longestProcessing.toFixed(1)} ms`,
			rate < this.sampleRate * SHORTFALL_RATIO,
		);
		this.windowStart = now;
		this.samples = this.longestWait = this.longestProcessing = 0;
	}
}
