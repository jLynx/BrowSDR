import type { VerifiedObservation } from '@/worker/decoders/rtk/receiver/types';
import type { DiscoveryProof } from './types';

/** Shared identity votes, not correction fragments; lookback copies cannot vote twice. */
export class RtkDiscoveryProofs {
	private sources = new Map<string, DiscoveryProof>();
	observe(radio: VerifiedObservation): boolean {
		const key = `${radio.profile}:${radio.source}`;
		const proof = this.sources.get(key) ?? { frames: [], confirmed: false, lastTime: radio.time };
		let hash = 2166136261;
		for (const byte of radio.packet.data) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
		// Filters can differ by a few samples. Match bytes and the absolute packet start,
		// while allowing identical payloads in genuinely later transmissions.
		if (proof.frames.some((frame) => frame.hash === hash && Math.abs(frame.time - radio.time) < 0.003)) return false;
		proof.frames = proof.frames.filter((frame) => Math.abs(radio.time - frame.time) <= 20);
		proof.frames.push({ time: radio.time, hash });
		if (proof.frames.length > 64) proof.frames.shift();
		proof.confirmed ||= radio.beacon || proof.frames.length >= 2;
		proof.lastTime = Math.max(proof.lastTime, radio.time);
		this.sources.delete(key);
		this.sources.set(key, proof);
		if (this.sources.size > 64) this.sources.delete(this.sources.keys().next().value!);
		return true;
	}
	confirmed(key: string): boolean {
		return this.sources.get(key)?.confirmed ?? false;
	}
	discontinuity(): void {
		for (const [key, proof] of this.sources) {
			if (!proof.confirmed) this.sources.delete(key);
			else proof.frames = [];
		}
	}
}
