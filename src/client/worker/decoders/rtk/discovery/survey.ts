import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { VfoParams } from '@/worker/runtime/types';
import type { RtkMessage, RtkProfile } from '@/worker/decoders/rtk/types';
import type { RadioObservation } from '@/worker/decoders/rtk/receiver/types';
import { RtkAcquisition } from '@/worker/decoders/rtk/receiver/acquisition';
import { RtkChannel } from '@/worker/decoders/rtk/receiver/channel';
import { RTK_RATE, timingPpm } from '@/worker/decoders/rtk/receiver/profiles';
import { verifiedObservation } from '@/worker/decoders/rtk/receiver/policy';
import type { RtkDiscoveryCatalog } from './catalog';

/** Keep searching both PHYs and all identities rather than promoting the first match. */
export class RtkSurvey {
	private acquisition: RtkAcquisition;
	private channels: RtkChannel[] = [];
	private epoch = 0;
	private frequency = 0;
	constructor(
		private Processor: typeof DspProcessor,
		private memory: { buffer: ArrayBuffer },
		private catalog: RtkDiscoveryCatalog,
		private receive: (profile: RtkProfile, message: RtkMessage) => void,
		private start: number,
		private end: number,
		private params: VfoParams,
		private profiles: Array<'rtk1' | 'rtk2'> = ['rtk1', 'rtk2'],
	) {
		this.acquisition = new RtkAcquisition(Processor);
	}
	tune(frequency: number, rate: number, center: number, epoch: number): void {
		this.free();
		this.catalog.discontinuity();
		this.epoch = epoch;
		this.frequency = frequency;
		this.acquisition.configure(rate, center, frequency);
		for (const profile of this.profiles) {
			const channel = new RtkChannel(
				this.Processor,
				this.memory,
				(message) => this.receive(profile, message),
				(radio) => this.observe(radio),
				{
					searchBoth250: profile === 'rtk2',
					filterInput: profile === 'rtk2' && rate > RTK_RATE,
					observerOnly: true,
					invalid: () => {
						this.catalog.discontinuity(profile);
						if (profile === 'rtk2') this.catalog.discontinuity('rtk3');
					},
				},
			);
			this.channels.push(channel);
			channel.configure(
				{
					...this.params,
					freq: frequency,
					rtk: true,
					rtkProfile: profile,
					rtkClockPpm: timingPpm[profile],
					rtkFollowHops: false,
					rtkFollowSource: '',
				},
				RTK_RATE,
				frequency,
			);
		}
	}
	private observe(input: RadioObservation): void {
		const radio = { ...input, time: input.time + this.epoch, frequencyHz: this.frequency * 1e6 + input.packet.cfoHz };
		if (radio.frequencyHz < this.start * 1e6 - 10000 || radio.frequencyHz > this.end * 1e6 + 10000) return;
		const verified = verifiedObservation(radio);
		if (verified) this.catalog.observe(verified);
		if (input.profile === 'rtk2') {
			const rtk3 = verifiedObservation({ ...radio, profile: 'rtk3' });
			if (rtk3) this.catalog.observe(rtk3);
		}
	}
	process(ptr: number, values: number, floatInput: boolean, chunkId?: number): void {
		const input = this.acquisition.process(ptr, values, floatInput);
		for (const channel of this.channels) channel.process(input.ptr, input.values, input.floatInput, chunkId);
	}
	discontinuity(): void {
		this.acquisition.discontinuity();
		this.catalog.discontinuity();
	}
	free(): void {
		for (const channel of this.channels) channel.reset();
		this.channels = [];
		this.acquisition.free();
	}
}
