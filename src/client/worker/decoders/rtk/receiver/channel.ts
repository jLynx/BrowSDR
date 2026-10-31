import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { VfoParams } from '@/worker/runtime/types';
import type { LoraProfile, LoraPacket, RtkMessage, RtkStatus, RtkProfile } from '@/worker/decoders/rtk/types';
import { LoraReceiver } from '@/worker/decoders/rtk/lora';
import { RtkTracker } from '@/worker/decoders/rtk/rtcm';
import { Rtk3Tracker } from '@/worker/decoders/rtk/rtk3/tracker';
import { Rtk2Tracker } from '@/worker/decoders/rtk/rtk2/tracker';
import { decodeRtk2Frame } from '@/worker/decoders/rtk/rtk2/frame';
import { decodeRtk3Frame } from '@/worker/decoders/rtk/rtk3/frame';
import { RtkHopFollower } from '@/worker/decoders/rtk/hopping/follower';
import { stationKey } from '@/worker/decoders/rtk/station-key';
import { RTK_PROFILES, RTK_RATE, profileName, physicalProfile } from './profiles';
import type { RadioObservation, ChannelOptions } from './types';
import { errorMessage } from '@/platform/errors';

const initialStatus = (): RtkStatus => ({
	state: 'off',
	message: 'Decoder off',
	samples: 0,
	syncs: 0,
	headers: 0,
	payloads: 0,
	codingErrors: 0,
	packets: 0,
	crcErrors: 0,
	discontinuities: 0,
});

export class RtkChannel {
	private key = '';
	private frequency = 923.118;
	private profile: RtkProfile = 'rtk1';
	private ddc?: DspProcessor;
	private direct = false;
	private scratch = new Float32Array(0);
	private lastChunk?: number;
	private tracker: RtkTracker | Rtk2Tracker | Rtk3Tracker = new RtkTracker();
	private lora?: LoraReceiver;
	private hopping?: RtkHopFollower;
	private inputRate = 0;
	private centerHz = 0;
	private inputTime = 0;
	private channelEpoch = 0;
	private lastEmit = 0;
	private status = initialStatus();
	constructor(
		private Processor: typeof DspProcessor,
		private memory: { buffer: ArrayBuffer },
		private post: (message: RtkMessage) => void,
		private observe?: (observation: RadioObservation) => void,
		private options: ChannelOptions = {},
	) {}
	configure(params: VfoParams, rate: number, center: number): void {
		this.frequency = params.freq;
		if (!params.rtk) {
			if (this.key) {
				this.reset();
				this.emit();
			}
			return;
		}
		const name = physicalProfile(params.rtkProfile),
			profile = RTK_PROFILES[name];
		const ppm = params.rtkClockPpm ?? (name === 'rtk3' ? 0 : name === 'rtk1' ? 20 : 10);
		const follow = name !== 'rtk1' && params.rtkFollowHops === true;
		const key = JSON.stringify([params.freq, rate, center, name, ppm, follow, params.rtkFollowSource]);
		if (this.key === key) return;
		this.reset();
		this.key = key;
		if (!profile || !Number.isFinite(ppm) || Math.abs(ppm) > 200) {
			this.fail('Choose a supported RTK profile and clock correction within ±200 ppm.');
			return;
		}
		if (
			params.freq < 900 ||
			params.freq > 930 ||
			rate < RTK_RATE ||
			Math.abs(params.freq - center) * 1e6 + profile.bandwidth * 0.6 > rate / 2
		) {
			this.fail('Tune a 900–930 MHz RTK signal inside the received band, at 1 MSPS or higher.');
			return;
		}
		try {
			this.profile = name;
			this.configureChannel(profile, rate, center, params.freq, follow, params.rtkFollowSource);
			this.tracker = name === 'rtk3' ? new Rtk3Tracker() : name === 'rtk2' ? new Rtk2Tracker() : new RtkTracker();
			this.lora = new LoraReceiver(
				profile,
				ppm,
				(packet) => this.packet(packet),
				() => {
					// RTK2 has a verified per-base sequence counter; a bad header alone
					// cannot establish loss. Actual IQ discontinuities still reset below.
					if (this.tracker instanceof Rtk2Tracker) this.tracker.rejectCandidate();
					else this.tracker.discontinuity();
					this.options.invalid?.();
				},
				(packet) => this.validPacket(packet),
			);
			this.status.state = 'receiving';
			this.status.message = `Listening on ${params.freq.toFixed(3)} MHz · ${profileName[name]}`;
			this.emit();
		} catch (error) {
			this.fail(errorMessage(error));
		}
	}
	private configureChannel(profile: LoraProfile, rate: number, center: number, frequency: number, follow: boolean, source?: string): void {
		this.inputRate = rate;
		this.centerHz = center * 1e6;
		if (follow && this.profile !== 'rtk1') {
			this.hopping = new RtkHopFollower(this.profile, frequency * 1e6, source || undefined);
			if (Math.max(Math.abs(this.hopping.minimumHz - this.centerHz), Math.abs(this.hopping.maximumHz - this.centerHz)) + 150000 > rate / 2)
				throw new Error(
					`${this.profile.toUpperCase()} NZ hop following needs ${((this.hopping.minimumHz - 150000) / 1e6).toFixed(3)}–${((this.hopping.maximumHz + 150000) / 1e6).toFixed(3)} MHz inside the received band. Use a suitable centre and 20 MSPS or higher.`,
				);
		}
		this.direct = !follow && !this.options.filterInput && rate === RTK_RATE && Math.abs(frequency - center) < 0.000001;
		if (!this.direct) {
			this.ddc =
				this.options.takeDdc?.() ?? new this.Processor(rate, (this.hopping?.frequencyHz ?? frequency * 1e6) - this.centerHz, RTK_RATE);
			this.ddc.set_if_sample_rate(RTK_RATE);
			this.ddc.set_bandwidth(profile.bandwidth * 1.2);
		}
	}
	private packet(packet: LoraPacket): void {
		if (this.hopping) {
			this.beacon(packet);
		}
		if (!this.options.observerOnly) this.tracker.process(packet);
		if (packet.startSample !== undefined)
			this.observe?.({
				profile: this.profile,
				packet,
				frequencyHz: this.hopping?.frequencyHz ?? this.frequency * 1e6,
				time: this.channelEpoch + packet.startSample / RTK_RATE,
			});
	}
	private beacon(packet: LoraPacket): void {
		if (packet.startSample === undefined) return;
		const time = this.channelEpoch + packet.startSample / RTK_RATE;
		if (this.profile === 'rtk3') {
			const frame = decodeRtk3Frame(packet);
			if (frame?.beaconMs !== undefined) this.hopping!.beacon(stationKey({ ...frame, netId: frame.address }), time);
		} else {
			const frame = decodeRtk2Frame(packet);
			if (
				frame?.format === 'compact' &&
				frame.body.length === 0 &&
				frame.hopSlot !== undefined &&
				Math.abs(915491000 + frame.hopSlot * 700000 - this.hopping!.frequencyHz) < 50000
			)
				this.hopping!.beacon(stationKey({ protocol: 'rtk2', network: frame.network, address: frame.address, netId: frame.address }), time);
		}
	}
	private validPacket(packet: LoraPacket): boolean {
		return this.profile === 'rtk2'
			? !!decodeRtk2Frame(packet) || (this.options.searchBoth250 === true && !!decodeRtk3Frame(packet))
			: this.profile === 'rtk3'
				? !!decodeRtk3Frame(packet)
				: packet.verified;
	}
	beginFollowing(source: string, headerTime: number): boolean {
		if (this.profile === 'rtk1' || !this.ddc) return false;
		this.hopping = new RtkHopFollower(this.profile, this.frequency * 1e6, source);
		this.hopping.beacon(source, headerTime);
		return true;
	}
	useInput(rate: number, center: number, time: number, takeDdc?: () => DspProcessor | undefined): void {
		this.ddc?.free();
		this.options = { takeDdc };
		this.configureChannel(RTK_PROFILES[this.profile], rate, center, this.frequency, false);
		this.startAt(time);
	}
	adoptTracker(tracker: Rtk3Tracker, time: number): void {
		this.tracker = tracker;
		this.startAt(time);
	}
	private startAt(time: number): void {
		this.inputTime = time;
		this.channelEpoch = time;
		this.status.samples = time * RTK_RATE;
		this.lora!.reset();
	}
	endFollowing(): void {
		if (!this.hopping) return;
		this.hopping = undefined;
		this.ddc!.set_shift(this.inputRate, this.frequency * 1e6 - this.centerHz);
		this.ddc!.reset();
		this.lora!.reset();
		this.tracker.discontinuity();
		this.channelEpoch = this.inputTime;
		delete this.status.hopFrequencyMHz;
		delete this.status.hopTracking;
		this.status.message = `Listening on ${this.frequency.toFixed(3)} MHz · ${profileName[this.profile]}`;
	}
	process(ptr: number, values: number, floatInput: boolean, chunkId?: number): void {
		if (!values || this.status.state !== 'receiving') return;
		try {
			if (chunkId !== undefined && this.lastChunk !== undefined && chunkId !== this.lastChunk + 1) {
				this.lora?.reset();
				this.tracker.discontinuity();
				this.ddc?.reset();
				this.hopping?.reset();
				this.channelEpoch = this.inputTime;
				this.status.discontinuities++;
			}
			this.lastChunk = chunkId;
			if (this.hopping) this.status.samples += this.decodeHops(ptr, values, floatInput) / 2;
			else {
				this.status.samples += this.decode(ptr, values, floatInput) / 2;
				this.inputTime += values / (2 * this.inputRate);
			}
			if (performance.now() - this.lastEmit >= 250) this.emit();
		} catch (error) {
			this.fail(errorMessage(error));
		}
	}
	private decodeHops(ptr: number, values: number, floatInput: boolean): number {
		let output = 0;
		for (let offset = 0; offset < values;) {
			if (this.hopping!.advance(this.inputTime)) {
				this.ddc!.set_shift(this.inputRate, this.hopping!.frequencyHz - this.centerHz);
				this.ddc!.reset();
				this.lora!.reset();
				this.channelEpoch = this.inputTime;
			}
			const untilHop = Math.max(1, Math.ceil((this.hopping!.deadline - this.inputTime) * this.inputRate));
			const count = Math.min(values - offset, untilHop * 2, Math.floor(this.inputRate * 0.02) * 2);
			output += this.decode(ptr + offset * (floatInput ? 4 : 1), count, floatInput);
			this.inputTime += count / (2 * this.inputRate);
			offset += count;
		}
		return output;
	}
	private decode(ptr: number, values: number, floatInput: boolean): number {
		if (this.direct) {
			if (floatInput) this.lora!.process(new Float32Array(this.memory.buffer, ptr, values));
			else {
				const bytes = new Int8Array(this.memory.buffer, ptr, values);
				if (this.scratch.length < values) this.scratch = new Float32Array(values);
				for (let i = 0; i < values; i++) this.scratch[i] = bytes[i] / 128;
				this.lora!.process(this.scratch.subarray(0, values));
			}
			return values;
		}
		const output = floatInput ? this.ddc!.process_iq_only_f32_ptr(ptr, values) : this.ddc!.process_iq_only_ptr(ptr, values);
		const count = this.ddc!.get_iq_output_len();
		if (count) this.lora!.process(new Float32Array(this.memory.buffer, output, count));
		return count;
	}
	reset(): void {
		this.ddc?.free();
		this.ddc = undefined;
		this.key = '';
		this.lastChunk = undefined;
		this.lora = undefined;
		this.hopping = undefined;
		this.inputTime = 0;
		this.channelEpoch = 0;
		this.tracker = new RtkTracker();
		this.status = initialStatus();
	}
	private fail(message: string): void {
		const key = this.key;
		this.reset();
		this.key = key;
		this.status.state = 'error';
		this.status.message = message;
		this.emit();
	}
	emit(): void {
		this.lastEmit = performance.now();
		if (this.lora) Object.assign(this.status, this.lora.counters);
		if (this.hopping) {
			this.status.hopFrequencyMHz = this.hopping.frequencyHz / 1e6;
			this.status.hopTracking = this.hopping.tracking;
			this.status.message = `${this.hopping.tracking ? 'Following' : 'Hunting on'} ${this.status.hopFrequencyMHz.toFixed(3)} MHz · recorded NZ ${this.profile.toUpperCase()} hops`;
		}
		if (this.tracker instanceof Rtk3Tracker || this.tracker instanceof Rtk2Tracker) Object.assign(this.status, this.tracker.counters);
		this.post({
			type: 'rtk',
			freq: this.frequency,
			profile: this.profile,
			status: { ...this.status },
			stations: this.tracker.snapshot(),
			rtcm: this.tracker.flush(),
		});
	}
}
