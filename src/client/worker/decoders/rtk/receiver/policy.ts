import type { RtkProfile, RtkHopDecision } from '@/worker/decoders/rtk/types';
import { decodeRtk2Frame } from '@/worker/decoders/rtk/rtk2/frame';
import { decodeRtk3Frame } from '@/worker/decoders/rtk/rtk3/frame';
import { stationKey } from '@/worker/decoders/rtk/station-key';
import { RTK_HOP_PLANS } from '@/worker/decoders/rtk/hopping/plans';
import type { RadioObservation, VerifiedObservation } from './types';

export function verifiedObservation(input: RadioObservation): VerifiedObservation | undefined {
	const { profile, packet, frequencyHz } = input;
	if (profile === 'rtk1') {
		const data = packet.data;
		if (!packet.verified || data.length < 8 || data[0] !== 0x2c || data[7] !== data.length - 8) return;
		return { ...input, source: stationKey({ scan: (data[5] << 8) | data[6], channel: data[1], netId: data[4] }), beacon: false };
	}
	if (profile === 'rtk2') {
		const frame = decodeRtk2Frame(packet);
		if (!frame) return;
		const beacon =
			frame.format === 'compact' &&
			frame.body.length === 0 &&
			frame.hopSlot !== undefined &&
			Math.abs(915491000 + frame.hopSlot * 700000 - frequencyHz) < 50000;
		return { ...input, source: stationKey({ ...frame, protocol: 'rtk2', netId: frame.address }), beacon };
	}
	const frame = decodeRtk3Frame(packet);
	return frame ? { ...input, source: stationKey({ ...frame, netId: frame.address }), beacon: frame.beaconMs !== undefined } : undefined;
}

export function hopPlanAvailability(
	profile: RtkProfile,
	frequencyHz: number,
	rate: number,
	centerHz: number,
): 'available' | 'unconfirmed' | 'band-limited' {
	if (profile === 'rtk1') return 'unconfirmed';
	const frequencies = RTK_HOP_PLANS[profile].frequencies;
	if (!frequencies.some((frequency) => Math.abs(frequencyHz - frequency) < 50000)) return 'unconfirmed';
	return Math.max(...frequencies.map((frequency) => Math.abs(frequency - centerHz))) + 150000 <= rate / 2 ? 'available' : 'band-limited';
}

/** Evidence is tied to one verified source, frequency and input-sample timeline. */
export class RtkAutoDetection {
	profile?: RtkProfile;
	source?: string;
	decision: RtkHopDecision = 'fixed';
	pending?: VerifiedObservation;
	private origin?: VerifiedObservation;
	private retryAfter = 0;
	private votes = new Map<string, { count: number; time: number; beacon?: VerifiedObservation }>();
	constructor(private preferredSource?: string) {}
	observe(input: RadioObservation): void {
		const radio = verifiedObservation(input);
		if (!radio || (this.preferredSource && radio.source !== this.preferredSource)) return;
		if (!this.profile && !this.vote(radio)) return;
		if (radio.profile !== this.profile || radio.source !== this.source || !radio.beacon) return;
		if (this.decision === 'checking') this.checkHop(radio);
		else if ((this.decision === 'fixed' || this.decision === 'unconfirmed') && radio.time >= this.retryAfter) this.pending = radio;
	}
	private vote(radio: VerifiedObservation): boolean {
		const key = `${radio.profile}:${radio.source}`;
		const previous = this.votes.get(key);
		const vote = {
			count: previous && radio.time - previous.time < 20 ? previous.count + 1 : 1,
			time: radio.time,
			beacon: radio.beacon ? radio : previous?.beacon,
		};
		this.votes.delete(key);
		this.votes.set(key, vote);
		if (this.votes.size > 16) this.votes.delete(this.votes.keys().next().value!);
		// A complete control beacon has a fixed structure as well as a radio checksum.
		// Data fragments require a second verified frame from the same source.
		if (vote.count < 2 && !radio.beacon) return false;
		this.profile = radio.profile;
		this.source = radio.source;
		this.pending = vote.beacon;
		return true;
	}
	private checkHop(radio: VerifiedObservation): void {
		if (this.origin && this.profile && this.profile !== 'rtk1') {
			const plan = RTK_HOP_PLANS[this.profile];
			const steps = Math.round((radio.time - this.origin.time) / plan.dwell);
			const slot = plan.frequencies.findIndex((frequency) => Math.abs(frequency - this.origin!.frequencyHz) < 50000);
			const expected = plan.frequencies[(slot + steps) % plan.frequencies.length];
			if (
				steps > 0 &&
				Math.abs(radio.time - this.origin.time - steps * plan.dwell) < 0.08 &&
				Math.abs(radio.frequencyHz - expected) < 50000 &&
				Math.abs(radio.frequencyHz - this.origin.frequencyHz) > 100000
			)
				this.decision = 'following';
		}
	}
	startProbe(origin: VerifiedObservation): void {
		this.origin = origin;
		this.pending = undefined;
		this.decision = 'checking';
	}
	advance(time: number): boolean {
		if (this.decision !== 'checking' || !this.origin || !this.profile || this.profile === 'rtk1') return false;
		const plan = RTK_HOP_PLANS[this.profile];
		if (time < this.origin.time + 4 * plan.dwell + 0.3) return false;
		this.decision = 'unconfirmed';
		this.retryAfter = time + plan.frequencies.length * plan.dwell;
		this.origin = undefined;
		return true;
	}
	discontinuity(): void {
		this.votes.clear();
		this.pending = undefined;
		if (this.decision === 'checking') {
			this.decision = 'unconfirmed';
			this.origin = undefined;
		}
	}
}
