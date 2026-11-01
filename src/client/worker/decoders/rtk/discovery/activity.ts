import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { VfoParams } from '@/worker/runtime/types';
import type { RtkMessage, RtkProfile } from '@/worker/decoders/rtk/types';
import { RtkDiscoveryCatalog } from './catalog';
import { RtkSurvey } from './survey';
import { CONFIRMATION_SECONDS } from './plan';
import type { RtkActivityCandidates } from './candidates';
import type { RtkIqHistory } from './history';
import { RtkDiscoveryProofs } from './proofs';
import type { ActivityLane } from './types';

/** Independent short probes; verified fragments get a bounded confirmation window. */
export class RtkActivityAcquisition {
	private lanes: ActivityLane[];
	private lastStarted = -Infinity;
	private generation?: number;
	private proofs = new RtkDiscoveryProofs();
	constructor(
		private Processor: typeof DspProcessor,
		private memory: { buffer: ArrayBuffer },
		private params: VfoParams,
		private rate: number,
		private center: number,
		private receive: (lane: number, profile: RtkProfile, message: RtkMessage) => void,
	) {
		this.lanes = Array.from({ length: rate <= 2000000 ? 2 : 1 }, () => ({
			catalog: new RtkDiscoveryCatalog(this.proofs),
			frequencyMHz: 0,
			deadline: 0,
			extended: false,
			cursor: 0,
			origin: 0,
			retried: false,
			packetsAtStart: 0,
		}));
	}
	get catalogs(): RtkDiscoveryCatalog[] {
		return this.lanes.map((lane) => lane.catalog);
	}
	get frequencies(): number[] {
		return this.lanes.filter((lane) => lane.survey).map((lane) => lane.frequencyMHz);
	}
	process(
		ptr: number,
		values: number,
		floatInput: boolean,
		time: number,
		queue: RtkActivityCandidates,
		history: RtkIqHistory,
		blocked: number[],
	): void {
		// A format change or cleared/overwritten history invalidates absolute cursors
		// and unconfirmed votes, while retaining already verified station identities.
		if (this.generation !== history.generation || this.lanes.some((lane) => lane.survey && lane.cursor < history.start)) {
			this.discontinuity();
			this.generation = history.generation;
		}
		for (const lane of this.lanes) {
			if (lane.survey && time >= lane.deadline) {
				lane.survey.free();
				lane.survey = undefined;
			}
		}
		// Stagger filter allocation and history decoding instead of starting every lane on one USB callback.
		const available = this.lanes.findIndex((lane) => !lane.survey);
		const catchingUp = this.lanes.some((lane) => lane.survey && lane.cursor < history.end - values);
		if (available >= 0 && !catchingUp && time - this.lastStarted >= 0.05) {
			const frequency = queue.take(time, [...blocked, ...this.frequencies]);
			if (frequency !== undefined) this.start(available, frequency, time + values / (2 * this.rate), history);
		}
		for (const lane of this.lanes) {
			if (!lane.survey) continue;
			const count = Math.min(history.end - lane.cursor, values * 2);
			if (lane.cursor === history.end - values) lane.survey.process(ptr, values, floatInput);
			else
				history.read(lane.cursor, count, ptr, values, floatInput, (inputPtr, inputValues, floats) =>
					lane.survey!.process(inputPtr, inputValues, floats),
				);
			lane.cursor += count;
			if (
				!lane.retried &&
				lane.cursor - lane.origin >= this.rate * 0.5 &&
				!lane.survey.headerDetected &&
				lane.catalog.packets === lane.packetsAtStart
			) {
				lane.retried = true;
				lane.cursor = Math.max(lane.origin, history.start);
				lane.deadline = Math.max(lane.deadline, time + 0.5);
				this.tune(this.lanes.indexOf(lane), time + values / (2 * this.rate), history, ['rtk1']);
			}
			if (!lane.extended && lane.catalog.awaitingFixedConfirmation) {
				lane.deadline = Math.max(lane.deadline, time + CONFIRMATION_SECONDS);
				lane.extended = true;
			}
		}
	}
	private start(index: number, frequencyMHz: number, time: number, history: RtkIqHistory): void {
		const lane = this.lanes[index];
		lane.frequencyMHz = frequencyMHz;
		lane.deadline = time + 0.75;
		lane.extended = false;
		this.lastStarted = time;
		lane.cursor = Math.max(history.start, history.end - Math.floor(this.rate * 0.25) * 2);
		lane.origin = lane.cursor;
		lane.retried = false;
		lane.packetsAtStart = lane.catalog.packets;
		this.tune(index, time, history, ['rtk2']);
	}
	private tune(index: number, time: number, history: RtkIqHistory, profiles: Array<'rtk1' | 'rtk2'>): void {
		const lane = this.lanes[index];
		lane.survey?.free();
		lane.survey = new RtkSurvey(
			this.Processor,
			this.memory,
			lane.catalog,
			(profile, message) => this.receive(index, profile, message),
			this.params.rtkScanStart ?? 915,
			this.params.rtkScanEnd ?? 928,
			this.params,
			profiles,
		);
		lane.survey.tune(lane.frequencyMHz, this.rate, this.center, time - (history.end - lane.cursor) / (2 * this.rate));
	}
	discontinuity(): void {
		this.lastStarted = -Infinity;
		this.proofs.discontinuity();
		for (const lane of this.lanes) {
			lane.survey?.free();
			lane.survey = undefined;
			lane.catalog.discontinuity();
		}
	}
	free(): void {
		this.discontinuity();
	}
}
