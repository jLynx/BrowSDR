/** Coalesce display snapshots at the source, including a trailing update when input stops. */
export class LatestStatus<T extends object> {
	private latest?: T;
	private timer?: ReturnType<typeof setTimeout>;
	private lastSent = -Infinity;

	constructor(
		private send: (status: T) => void,
		private intervalMs = 200,
	) {}

	push(status: T): void {
		this.latest = { ...status };
		const remaining = this.intervalMs - (performance.now() - this.lastSent);
		if (remaining <= 0) {
			this.flush();
		} else if (this.timer === undefined) {
			this.timer = setTimeout(() => this.flush(), remaining);
		}
	}

	reset(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.latest = undefined;
		this.lastSent = -Infinity;
	}

	private flush(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.latest) return;
		const status = this.latest;
		this.latest = undefined;
		this.lastSent = performance.now();
		this.send(status);
	}
}
