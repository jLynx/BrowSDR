import { ChannelSamples } from './samples';
import { ChirpSpectrum } from './spectrum';
import { decodeHeader, decodePayload } from './coding';
import type { LoraHeader, LoraPacket, LoraProfile } from './types';

const signedBin = (bin: number) => ((bin + 192) % 128) - 64;

/** Streaming SF7 acquisition, explicit headers and LoRa payload recovery. */
export class LoraReceiver {
	private samples = new ChannelSamples();
	private spectrum: ChirpSpectrum;
	private cursor = 0;
	private run = 0;
	private phaseR = 0;
	private phaseQ = 0;
	private previous?: { bin: number; real: number; imag: number };
	private lock?: { at: number; bin: number; fraction: number };
	private frame?: { start: number; cfo: number; sync: [number, number]; header?: LoraHeader };
	readonly counters = {
		syncs: 0,
		headers: 0,
		payloads: 0,
		packets: 0,
		crcErrors: 0,
		codingErrors: 0,
		syncSymbols: undefined as [number, number] | undefined,
	};
	constructor(
		private profile: LoraProfile,
		private clockPpm: number,
		private onPacket: (packet: LoraPacket) => void,
		private onInvalid: () => void = () => {},
		private validate?: (packet: LoraPacket) => boolean,
	) {
		this.spectrum = new ChirpSpectrum(this.samples, profile.oversample);
	}

	process(input: Float32Array): void {
		// Split large USB/DDC deliveries to keep bounded history and latency.
		for (let offset = 0; offset < input.length; offset += 65536) {
			this.samples.append(input.subarray(offset, offset + 65536));
			this.drain();
			const retain = this.frame ? this.frame.start - this.symbol * 4 : this.cursor - this.symbol * 10;
			this.samples.discardBefore(retain);
		}
	}
	private get symbol(): number {
		return 128 * this.profile.oversample;
	}
	private drain(): void {
		while (this.cursor + this.symbol * 4 + 4 < this.samples.end) {
			if (this.frame) {
				if (!this.recover()) break;
				continue;
			}
			this.search();
			this.cursor += this.symbol;
		}
	}
	private search(): void {
		const up = this.spectrum.peak(this.cursor);
		const down = this.spectrum.peak(this.cursor, true);
		const same = !this.previous || Math.abs(signedBin(up.bin - this.previous.bin)) <= 1;
		if (up.coherence > 0.3 && same) {
			if (this.previous) {
				this.phaseR += up.real * this.previous.real + up.imag * this.previous.imag;
				this.phaseQ += up.imag * this.previous.real - up.real * this.previous.imag;
			}
			if (++this.run >= 6) this.lock = { at: this.cursor, bin: up.bin, fraction: Math.atan2(this.phaseQ, this.phaseR) / (2 * Math.PI) };
		} else {
			this.run = 0;
			this.phaseR = 0;
			this.phaseQ = 0;
		}
		this.previous = up.coherence > 0.3 ? up : undefined;
		if (down.coherence > 0.3 && this.lock && this.cursor - this.lock.at < 6 * this.symbol) this.synchronize(down.bin);
	}
	private synchronize(downBin: number): void {
		const lock = this.lock!;
		let integer = Math.round((signedBin(lock.bin) + signedBin(downBin)) / 2 - lock.fraction);
		if (integer > 32) integer -= 64;
		if (integer < -32) integer += 64;
		let best = -1,
			aligned = 0,
			cfo = 0;
		for (let candidate = integer - 1; candidate <= integer + 1; candidate++) {
			const shift = signedBin(lock.bin - candidate) * this.profile.oversample;
			for (let fine = -2; fine <= 2; fine += 0.25) {
				const at = this.cursor - shift + fine,
					preamble = lock.at - shift + fine;
				if (Math.min(at, preamble) < this.samples.base || at + this.symbol >= this.samples.end) continue;
				const frequency = candidate + lock.fraction;
				const score = this.spectrum.coherence(at, true, frequency) + this.spectrum.coherence(preamble, false, frequency);
				if (score > best) {
					best = score;
					aligned = at;
					cfo = frequency;
				}
			}
		}
		if (best < 1) return;
		if (aligned - this.symbol >= this.samples.base && this.spectrum.peak(aligned - this.symbol, true).coherence > 0.25)
			aligned -= this.symbol;
		if (aligned - 2 * this.symbol < this.samples.base) return;
		const sync: [number, number] = [
			this.spectrum.peak(aligned - 2 * this.symbol, false, cfo).bin,
			this.spectrum.peak(aligned - this.symbol, false, cfo).bin,
		];
		const matches = (expected: [number, number]) => sync.every((bin, i) => Math.abs(signedBin(bin - expected[i])) <= 2);
		if (!matches(this.profile.sync) && !(this.profile.alternateSync && matches(this.profile.alternateSync))) return;
		this.counters.syncs++;
		this.frame = { start: aligned + 2.25 * this.symbol, cfo, sync };
	}
	private recover(): boolean {
		const frame = this.frame!,
			step = this.symbol * (1 + this.clockPpm / 1e6);
		if (!frame.header) {
			if (frame.start + 8 * step + 4 >= this.samples.end) return false;
			const headerBins = Array.from({ length: 8 }, (_, i) => this.spectrum.peak(frame.start + i * step, false, frame.cfo).bin);
			frame.header = decodeHeader(headerBins, this.profile.ldro);
			if (!frame.header) {
				this.finish(frame.start + 8 * step);
				this.onInvalid();
				return true;
			}
			this.counters.headers++;
			// Publish the observed symbols only after the explicit header checksum passes.
			this.counters.syncSymbols = frame.sync;
		}
		if (frame.start + frame.header.symbols * (step + this.symbol * 20e-6) + 4 >= this.samples.end) return false;
		const recovered = this.payload(frame, frame.header, step);
		const packet = recovered.packet;
		this.counters.payloads++;
		this.counters.codingErrors += packet.codingErrors ?? 0;
		if (packet.verified) this.counters.packets++;
		else if (packet.hasCrc) this.counters.crcErrors++;
		this.onPacket({ ...packet, startSample: frame.start });
		this.finish(frame.start + frame.header.symbols * recovered.step);
		return true;
	}
	private payload(frame: { start: number; cfo: number }, header: LoraHeader, step: number) {
		const decode = (timing: number) => {
			const bins = Array.from({ length: header.symbols }, (_, i) => this.spectrum.peak(frame.start + i * timing, false, frame.cfo).bin);
			return decodePayload(bins, header, this.profile.ldro, (frame.cfo * this.profile.bandwidth) / 128);
		};
		const valid = (packet: LoraPacket) => packet.verified || this.validate?.(packet) === true;
		const packet = decode(step);
		if (valid(packet) || (!header.hasCrc && !this.validate) || header.symbols <= 24) return { packet, step };
		// Long packets accumulate sample-clock error. Retry a bounded neighbourhood of
		// the configured timing, accepting a retry only with a radio/application checksum.
		for (const delta of [-5, 5, -10, 10, -15, 15, -20, 20]) {
			if (Math.abs(this.clockPpm + delta) > 200) continue;
			const timing = step + (this.symbol * delta) / 1e6;
			const candidate = decode(timing);
			if (valid(candidate)) return { packet: candidate, step: timing };
		}
		return { packet, step };
	}
	private finish(at: number): void {
		this.cursor = Math.ceil(at);
		this.frame = undefined;
		this.lock = undefined;
		this.previous = undefined;
		this.run = 0;
		this.phaseR = 0;
		this.phaseQ = 0;
	}
	reset(): void {
		this.samples.reset();
		this.finish(0);
	}
}
