/** Bounded activity hints, with a cooldown so persistent non-RTK peaks cannot monopolise the scout. */
export class RtkActivityCandidates {
	private pending: Array<{ frequencyMHz: number; seen: number }> = [];
	private tried = new Map<number, number>();
	offer(frequencies: number[], time: number, start: number, end: number, current: number): void {
		const next: typeof this.pending = [];
		for (const frequencyMHz of frequencies.slice(0, 32)) {
			if (!Number.isFinite(frequencyMHz) || frequencyMHz < start || frequencyMHz > end || Math.abs(frequencyMHz - current) < 0.05) continue;
			if (next.some((candidate) => Math.abs(candidate.frequencyMHz - frequencyMHz) < 0.05) || this.recentlyTried(frequencyMHz, time))
				continue;
			next.push({ frequencyMHz, seen: time });
		}
		for (const candidate of this.pending) {
			if (time - candidate.seen > 30 || Math.abs(candidate.frequencyMHz - current) < 0.05) continue;
			if (!next.some((other) => Math.abs(other.frequencyMHz - candidate.frequencyMHz) < 0.05)) next.push(candidate);
			if (next.length >= 32) break;
		}
		this.pending = next.slice(0, 32);
	}
	private recentlyTried(frequency: number, time: number): boolean {
		for (const [previous, visited] of this.tried) if (Math.abs(previous - frequency) < 0.05 && time - visited < 30) return true;
		return false;
	}
	take(time: number, blocked?: number | number[]): number | undefined {
		const frequencies = blocked === undefined ? [] : typeof blocked === 'number' ? [blocked] : blocked;
		this.pending = this.pending.filter(
			(candidate) => time - candidate.seen <= 30 && !frequencies.some((frequency) => Math.abs(candidate.frequencyMHz - frequency) < 0.05),
		);
		const next = this.pending.shift();
		if (!next) return;
		this.tried.set(next.frequencyMHz, time);
		if (this.tried.size > 128) this.tried.delete(this.tried.keys().next().value!);
		return next.frequencyMHz;
	}
	frequencies(time: number): number[] {
		return this.pending.filter((candidate) => time - candidate.seen <= 30).map((candidate) => candidate.frequencyMHz);
	}
}
