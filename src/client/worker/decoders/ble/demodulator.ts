import { parseAdvertisement, validHeader } from './packets';
import type { BleAdvertisement, BleLane } from './types';

const makeLane = (): BleLane => ({
	access: 0,
	preamble: 0,
	bytes: new Uint8Array(42),
	bits: 0,
	length: 0,
	whitening: 0,
	polarity: 1,
	power: 0,
	collecting: false,
});

/** LE 1M GFSK discriminator at 2 MSPS, searching both symbol phases and IQ polarities. */
export class BleDemodulator {
	private lanes = [makeLane(), makeLane()];
	private previousI = 0;
	private previousQ = 0;
	private phase = 0;
	private samples = 0;
	private lastFrame = -100;
	constructor(
		private channel: number,
		private post: (packet: BleAdvertisement) => void,
	) {}

	reset(): void {
		this.lanes = [makeLane(), makeLane()];
		this.previousI = this.previousQ = this.phase = this.samples = 0;
		this.lastFrame = -100;
	}

	process(iq: Float32Array): void {
		for (let index = 0; index + 1 < iq.length; index += 2) {
			const i = iq[index],
				q = iq[index + 1];
			const phase = Math.atan2(q * this.previousI - i * this.previousQ, i * this.previousI + q * this.previousQ);
			this.previousI = i;
			this.previousQ = q;
			const lane = this.lanes[this.samples++ & 1];
			this.bit(lane, phase + this.phase > 0 ? 1 : 0, i * i + q * q);
			this.phase = phase;
		}
	}

	private bit(lane: BleLane, bit: number, power: number): void {
		lane.preamble = ((lane.preamble >>> 1) | ((lane.access & 1) << 7)) & 255;
		lane.access = ((lane.access >>> 1) | (bit << 31)) >>> 0;
		if (!lane.collecting) {
			const normal = lane.access === 0x8e89bed6 && lane.preamble === 0xaa;
			const inverted = lane.access === ~0x8e89bed6 >>> 0 && lane.preamble === 0x55;
			if (!normal && !inverted) return;
			lane.collecting = true;
			lane.bits = 0;
			lane.length = 0;
			lane.bytes.fill(0);
			lane.whitening = this.channel | 0x40;
			lane.polarity = normal ? 0 : 1;
			lane.power = 0;
			return;
		}
		const whiten = lane.whitening & 1;
		lane.whitening = (lane.whitening >>> 1) ^ (whiten ? 0x44 : 0);
		lane.bytes[lane.bits >> 3] |= (bit ^ lane.polarity ^ whiten) << (lane.bits & 7);
		lane.bits++;
		lane.power += power;
		if (lane.bits === 16) {
			if (!validHeader(lane.bytes[0], lane.bytes[1])) {
				lane.collecting = false;
				return;
			}
			lane.length = (lane.bytes[1] + 5) * 8;
		}
		if (lane.length && lane.bits === lane.length) {
			const packet = parseAdvertisement(
				lane.bytes.subarray(0, lane.bits / 8),
				this.channel,
				10 * Math.log10(Math.max(1e-12, lane.power / lane.bits)),
			);
			if (packet && this.samples - this.lastFrame > 4) {
				this.lastFrame = this.samples;
				this.post(packet);
			}
			lane.collecting = false;
		}
	}
}
