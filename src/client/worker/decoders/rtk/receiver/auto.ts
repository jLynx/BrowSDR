import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { VfoParams } from '@/worker/runtime/types';
import type { RtkMessage, RtkProfile } from '@/worker/decoders/rtk/types';
import { RtkChannel } from './channel';
import { RtkAutoDetection, hopPlanAvailability } from './policy';
import { timingPpm, RTK_RATE } from './profiles';
import { RtkAcquisition } from './acquisition';
import { errorMessage } from '@/platform/errors';
import { Rtk3Tracker } from '@/worker/decoders/rtk/rtk3/tracker';
import { decodeRtk3Frame } from '@/worker/decoders/rtk/rtk3/frame';
import { decodeRtk2Frame } from '@/worker/decoders/rtk/rtk2/frame';
import type { RadioObservation } from './types';

const profiles: RtkProfile[] = ['rtk1', 'rtk2'];
const decisions = {
	fixed: 'Listening on the tuned channel',
	checking: 'Checking the NZ hop plan',
	following: 'Verified NZ hop following',
	unconfirmed: 'Listening on the tuned channel; hopping not confirmed',
	'band-limited': 'Listening on the tuned channel; receive the whole NZ plan to check hopping',
};

export class RtkAutoReceiver {
	private key = '';
	private params?: VfoParams;
	private rate = 0;
	private center = 0;
	private time = 0;
	private lastChunk?: number;
	private lastEmit = 0;
	private channels = new Map<RtkProfile, RtkChannel>();
	private messages = new Map<RtkProfile, RtkMessage>();
	private frames = new Map<RtkProfile, RtkMessage['rtcm']>();
	private detection = new RtkAutoDetection();
	private selected?: RtkProfile;
	private acquisition: RtkAcquisition;
	private error?: string;
	private rtk3Tracker = new Rtk3Tracker();
	constructor(
		private Processor: typeof DspProcessor,
		private memory: { buffer: ArrayBuffer },
		private post: (message: RtkMessage) => void,
	) {
		this.acquisition = new RtkAcquisition(Processor);
	}
	configure(params: VfoParams, rate: number, center: number): void {
		const key = JSON.stringify([params.rtk, params.freq, rate, center, params.rtkFollowSource]);
		if (key === this.key) return;
		this.reset();
		this.key = key;
		this.params = params;
		this.rate = rate;
		this.center = center;
		this.detection = new RtkAutoDetection(params.rtkFollowSource || undefined);
		if (params.rtk) {
			try {
				this.acquisition.configure(rate, center, params.freq);
				for (const profile of profiles) {
					const channel = new RtkChannel(
						this.Processor,
						this.memory,
						(message) => this.receive(profile, message),
						(input) => this.observe(input),
						{
							searchBoth250: profile === 'rtk2',
							filterInput: profile === 'rtk2' && rate > RTK_RATE,
							invalid: () => this.rtk3Tracker.discontinuity(),
						},
					);
					this.channels.set(profile, channel);
					channel.configure(
						{ ...params, rtkProfile: profile, rtkClockPpm: timingPpm[profile], rtkFollowHops: false },
						RTK_RATE,
						params.freq,
					);
				}
			} catch (error) {
				this.error = errorMessage(error);
			}
		}
		this.emit();
	}
	private receive(profile: RtkProfile, message: RtkMessage): void {
		this.messages.set(profile, message);
		const frames = this.frames.get(profile) ?? [];
		frames.push(...message.rtcm);
		if (frames.length > 512) frames.splice(0, frames.length - 512);
		this.frames.set(profile, frames);
		if (profile === 'rtk2' && !this.selected)
			this.receive('rtk3', {
				...message,
				profile: 'rtk3',
				status: { ...message.status, ...this.rtk3Tracker.counters },
				stations: this.rtk3Tracker.snapshot(),
				rtcm: this.rtk3Tracker.flush(),
			});
	}
	private observe(input: RadioObservation): void {
		this.detection.observe(input);
		if (input.profile !== 'rtk2' || this.selected) return;
		this.detection.observe({ ...input, profile: 'rtk3' });
		if (decodeRtk3Frame(input.packet)) this.rtk3Tracker.process(input.packet);
		else if (!decodeRtk2Frame(input.packet)) this.rtk3Tracker.discontinuity();
	}
	process(ptr: number, values: number, floatInput: boolean, chunkId?: number): void {
		if (!values || !this.params?.rtk || this.error) return;
		try {
			if (chunkId !== undefined && this.lastChunk !== undefined && chunkId !== this.lastChunk + 1) {
				if (this.detection.decision === 'checking' && this.selected) this.channels.get(this.selected)!.endFollowing();
				this.detection.discontinuity();
				this.rtk3Tracker.discontinuity();
				this.acquisition.discontinuity();
			}
			this.lastChunk = chunkId;
			const input = this.selected ? { ptr, values, floatInput } : this.acquisition.process(ptr, values, floatInput);
			for (const channel of this.channels.values()) channel.process(input.ptr, input.values, input.floatInput, chunkId);
			this.time += values / (2 * this.rate);
			if (!this.selected && this.detection.profile) {
				this.selected = this.detection.profile;
				this.promote();
				this.acquisition.free();
				for (const [profile, channel] of this.channels)
					if (profile !== this.selected) {
						channel.reset();
						this.channels.delete(profile);
						this.frames.delete(profile);
						this.messages.delete(profile);
					}
				this.channels.get(this.selected)!.emit();
			}
			this.checkHops();
			if (performance.now() - this.lastEmit >= 250) this.emit();
		} catch (error) {
			this.error = errorMessage(error);
			this.emit();
		}
	}
	private promote(): void {
		if (this.selected === 'rtk3') {
			const channel = new RtkChannel(
				this.Processor,
				this.memory,
				(message) => this.receive('rtk3', message),
				(input) => this.detection.observe(input),
				{ takeDdc: () => this.acquisition.take() },
			);
			channel.configure({ ...this.params!, rtkProfile: 'rtk3', rtkClockPpm: timingPpm.rtk3, rtkFollowHops: false }, this.rate, this.center);
			channel.adoptTracker(this.rtk3Tracker, this.time);
			this.channels.set('rtk3', channel);
		} else this.channels.get(this.selected!)!.useInput(this.rate, this.center, this.time, () => this.acquisition.take());
	}
	private checkHops(): void {
		if (!this.selected) return;
		const channel = this.channels.get(this.selected)!;
		if (this.detection.advance(this.time)) channel.endFollowing();
		const beacon = this.detection.pending;
		if (!beacon) return;
		this.detection.pending = undefined;
		const available = hopPlanAvailability(this.selected, beacon.frequencyHz, this.rate, this.center * 1e6);
		if (available !== 'available') this.detection.decision = available;
		else if (channel.beginFollowing(beacon.source, beacon.time)) this.detection.startProbe(beacon);
	}
	emit(): void {
		if (!this.params) return;
		this.lastEmit = performance.now();
		if (this.selected && !this.error) {
			this.channels.get(this.selected)!.emit();
			const message = this.messages.get(this.selected)!;
			this.post({
				...message,
				rtcm: this.frames.get(this.selected) ?? [],
				status: {
					...message.status,
					detectedProfile: this.selected,
					hopDecision: this.detection.decision,
					hopTracking: this.detection.decision === 'following' && message.status.hopTracking === true,
					message: `${this.selected.toUpperCase()} detected · ${decisions[this.detection.decision]}`,
				},
			});
			this.frames.set(this.selected, []);
			return;
		}
		const messages = [...this.messages.values()];
		const failure =
			this.error ??
			(messages.length && messages.every((message) => message.status.state === 'error') ? messages[0].status.message : undefined);
		this.post({
			type: 'rtk',
			freq: this.params.freq,
			stations: [],
			rtcm: [],
			status: {
				state: !this.params.rtk ? 'off' : failure ? 'error' : 'receiving',
				message: !this.params.rtk ? 'Decoder off' : (failure ?? 'Auto: waiting for a verified RTK beacon or two data frames'),
				samples: this.time * RTK_RATE,
				syncs: messages.reduce((n, m) => n + m.status.syncs, 0),
				headers: messages.reduce((n, m) => n + m.status.headers, 0),
				packets: 0,
				crcErrors: 0,
				discontinuities: Math.max(0, ...messages.map((m) => m.status.discontinuities)),
			},
		});
	}
	reset(): void {
		for (const channel of this.channels.values()) channel.reset();
		this.acquisition.free();
		this.channels.clear();
		this.messages.clear();
		this.frames.clear();
		this.detection = new RtkAutoDetection();
		this.selected = undefined;
		this.params = undefined;
		this.key = '';
		this.time = 0;
		this.lastChunk = undefined;
		this.error = undefined;
		this.rtk3Tracker = new Rtk3Tracker();
	}
}
