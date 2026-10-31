import { RTK_HOP_PLANS } from './plans';

/** Sample-time following of a measured plan, anchored only by verified beacons. */
export class RtkHopFollower {
	private plan: (typeof RTK_HOP_PLANS)['rtk2' | 'rtk3'];
	private slot = 0;
	private phase?: number;
	private lastBeacon = 0;
	private address?: string | number;
	constructor(profile: 'rtk2' | 'rtk3', frequencyHz: number) {
		this.plan = RTK_HOP_PLANS[profile];
		const slot = this.plan.frequencies.findIndex((frequency) => Math.abs(frequencyHz - frequency) < 50000);
		if (slot >= 0) this.slot = slot;
	}
	get minimumHz(): number {
		return Math.min(...this.plan.frequencies);
	}
	get maximumHz(): number {
		return Math.max(...this.plan.frequencies);
	}
	get frequencyHz(): number {
		return this.plan.frequencies[this.slot];
	}
	get deadline(): number {
		return this.phase === undefined ? Infinity : this.phase + this.plan.dwell - this.plan.guard;
	}
	get tracking(): boolean {
		return this.phase !== undefined;
	}
	beacon(address: string | number, headerTime: number): void {
		if (this.address !== undefined && address !== this.address) return;
		this.address = address;
		// Header follows 16 preamble, two sync and 2.25 delimiter symbols at SF7/BW250.
		this.phase = headerTime - (20.25 * 128) / 250000;
		this.lastBeacon = headerTime;
	}
	advance(time: number): boolean {
		if (this.phase === undefined || time < this.deadline) return false;
		if (time - this.lastBeacon > (this.plan.frequencies.length + 1) * this.plan.dwell) {
			this.reset();
			return false;
		}
		const steps = Math.floor((time - this.deadline) / this.plan.dwell) + 1;
		this.slot = (this.slot + steps) % this.plan.frequencies.length;
		this.phase += steps * this.plan.dwell;
		return true;
	}
	reset(): void {
		this.phase = undefined;
		this.address = undefined;
	}
}
