import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { VfoParams } from '@/worker/runtime/types';
import type { RtkMessage } from '@/worker/decoders/rtk/types';
import { errorMessage } from '@/platform/errors';
import { RtkDiscoveryCatalog } from './catalog';
import { RtkSurvey } from './survey';
import { surveyPlan, priorityPlan } from './plan';
import { discoveryInventory } from './inventory';
import type { SurveyChannel } from './types';

export class RtkDiscoveryReceiver {
	private key = '';
	private params?: VfoParams;
	private catalog = new RtkDiscoveryCatalog();
	private survey?: RtkSurvey;
	private priorities: Array<{ catalog: RtkDiscoveryCatalog; survey?: RtkSurvey; channel: SurveyChannel; deadline: number }> = [];
	private plan: SurveyChannel[] = [];
	private cursor = 0;
	private pass = 1;
	private time = 0;
	private deadline = 0;
	private rate = 0;
	private center = 0;
	private lastEmit = 0;
	private lastChunk?: number;
	private gaps = 0;
	private totals = { syncs: 0, headers: 0, packets: 0, crcErrors: 0 };
	private previous = new Map<string, RtkMessage['status']>();
	private error?: string;
	constructor(
		private Processor: typeof DspProcessor,
		private memory: { buffer: ArrayBuffer },
		private post: (message: RtkMessage) => void,
	) {}
	configure(params: VfoParams, rate: number, center: number): void {
		const key = JSON.stringify([params.rtk, params.freq, params.rtkScanStart, params.rtkScanEnd, rate, center]);
		if (key === this.key) return;
		this.reset();
		this.key = key;
		this.params = params;
		this.rate = rate;
		this.center = center;
		if (params.rtk) {
			try {
				const start = params.rtkScanStart ?? 915,
					end = params.rtkScanEnd ?? 928;
				this.plan = surveyPlan(start, end, rate, center);
				this.survey = new RtkSurvey(
					this.Processor,
					this.memory,
					this.catalog,
					(profile, message) => this.receive(profile, message),
					start,
					end,
					params,
				);
				this.tune();
				for (const channel of priorityPlan(start, end, rate)) {
					const catalog = new RtkDiscoveryCatalog();
					const survey = new RtkSurvey(
						this.Processor,
						this.memory,
						catalog,
						(profile, message) => this.receive(`${channel.frequencyMHz}:${profile}`, message),
						start,
						end,
						params,
						['rtk2'],
					);
					this.priorities.push({ catalog, survey, channel, deadline: channel.seconds });
					survey.tune(channel.frequencyMHz, rate, center, 0);
				}
			} catch (error) {
				this.error = errorMessage(error);
				this.survey?.free();
				for (const lane of this.priorities) lane.survey?.free();
			}
		}
		this.emit();
	}
	private receive(profile: string, message: RtkMessage): void {
		if (message.status.state === 'error') this.error = message.status.message;
		const previous = this.previous.get(profile);
		for (const name of ['syncs', 'headers', 'packets', 'crcErrors'] as const)
			this.totals[name] += Math.max(0, message.status[name] - (previous?.[name] ?? 0));
		this.previous.set(profile, message.status);
	}
	private tune(): void {
		this.previous.delete('rtk1');
		this.previous.delete('rtk2');
		const channel = this.plan[this.cursor];
		this.survey!.tune(channel.frequencyMHz, this.rate, this.center, this.time);
		this.deadline = this.time + channel.seconds;
	}
	process(ptr: number, values: number, floatInput: boolean, chunkId?: number): void {
		if (!values || !this.params?.rtk || this.error) return;
		try {
			if (chunkId !== undefined && this.lastChunk !== undefined && chunkId !== this.lastChunk + 1) {
				this.survey!.discontinuity();
				for (const lane of this.priorities) lane.survey?.discontinuity();
				this.gaps++;
			}
			this.lastChunk = chunkId;
			this.survey!.process(ptr, values, floatInput, chunkId);
			this.processPriorities(ptr, values, floatInput, chunkId);
			this.time += values / (2 * this.rate);
			if (this.time >= this.deadline) {
				this.cursor = (this.cursor + 1) % this.plan.length;
				if (!this.cursor) this.pass++;
				if (this.plan.length > 1) this.tune();
				else this.deadline += this.plan[0].seconds;
			}
			if (performance.now() - this.lastEmit >= 250) this.emit();
		} catch (error) {
			this.error = errorMessage(error);
			this.survey?.free();
			for (const lane of this.priorities) lane.survey?.free();
			this.emit();
		}
	}
	private processPriorities(ptr: number, values: number, floatInput: boolean, chunkId?: number): void {
		for (const lane of this.priorities) {
			lane.survey?.process(ptr, values, floatInput, chunkId);
			if (this.time + values / (2 * this.rate) >= lane.deadline) {
				lane.survey?.free();
				lane.survey = undefined;
			}
		}
	}
	emit(): void {
		if (!this.params) return;
		this.lastEmit = performance.now();
		const catalogs = [this.catalog, ...this.priorities.map((lane) => lane.catalog)];
		const stations = discoveryInventory(catalogs);
		this.post({
			type: 'rtk',
			freq: this.params.freq,
			stations,
			rtcm: catalogs.flatMap((catalog) => catalog.flush()),
			status: {
				state: !this.params.rtk ? 'off' : this.error ? 'error' : 'receiving',
				message: !this.params.rtk ? 'Decoder off' : (this.error ?? `Discovering RTK bases · ${stations.length} verified identities`),
				samples: this.time * 1000000,
				...this.totals,
				packets: catalogs.reduce((sum, catalog) => sum + catalog.packets, 0),
				discontinuities: this.gaps,
				...(!this.params.rtk || this.error
					? {}
					: {
							scan: {
								startMHz: this.params.rtkScanStart ?? 915,
								endMHz: this.params.rtkScanEnd ?? 928,
								frequencyMHz: this.plan[this.cursor].frequencyMHz,
								channel: this.cursor + 1,
								channels: this.plan.length,
								pass: this.pass,
								remainingSeconds:
									Math.max(0, this.deadline - this.time) +
									this.plan.slice(this.cursor + 1).reduce((sum, channel) => sum + channel.seconds, 0),
								priorityFrequenciesMHz: this.priorities.filter((lane) => lane.survey).map((lane) => lane.channel.frequencyMHz),
							},
						}),
			},
		});
	}
	reset(): void {
		this.survey?.free();
		for (const lane of this.priorities) lane.survey?.free();
		this.priorities = [];
		this.survey = undefined;
		this.catalog = new RtkDiscoveryCatalog();
		this.plan = [];
		this.params = undefined;
		this.key = '';
		this.time = this.deadline = this.cursor = this.gaps = 0;
		this.pass = 1;
		this.lastChunk = undefined;
		this.error = undefined;
		this.totals = { syncs: 0, headers: 0, packets: 0, crcErrors: 0 };
		this.previous.clear();
	}
}
