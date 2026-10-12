import type { RxStreamStats } from '@/radio/types';
import { STREAM_PKT_SIZE, STREAM_PAYLOAD } from './protocol';

const SAMPLES_PER_PACKET = STREAM_PAYLOAD / 4;
const COUNTER_MASK = (1n << 64n) - 1n;

/** LimeSuite's FPGA packet sample counter identifies loss before DSP dispatch. */
export class LimeStreamStats {
	private previous: bigint | undefined;
	private gaps = 0;
	private missing = 0;
	private discontinuities = 0;
	private within = 0;
	private between = 0;
	private largest = 0;
	private lastArrival: number | undefined;
	private arrivalMs = 0;
	private arrivalMaxMs = 0;
	private previousServiceMs = 0;
	private serviceSumMs = 0;
	private serviceMaxMs = 0;
	private servicedTransfers = 0;
	private lastGapArrivalMs = 0;
	private lastGapPreviousServiceMs = 0;
	private highestSequence = -1;
	private outOfOrder = 0;
	private samplesPerPacket = SAMPLES_PER_PACKET;
	private linkBits = 16;
	private transferBytes = 524288;
	private usbOnly = false;
	private transferCount = 0;
	private receivedBytes = 0;
	private receivedSamples = 0;
	private firstArrival: number | undefined;
	private lastTransferBytes = 0;

	reset(samplesPerPacket = SAMPLES_PER_PACKET, linkBits = 16, transferBytes = 524288, usbOnly = false): void {
		this.samplesPerPacket = samplesPerPacket;
		this.linkBits = linkBits;
		this.transferBytes = transferBytes;
		this.usbOnly = usbOnly;
		this.transferCount = this.receivedBytes = this.receivedSamples = this.lastTransferBytes = 0;
		this.firstArrival = undefined;
		this.previous = undefined;
		this.gaps = this.missing = this.discontinuities = 0;
		this.within = this.between = this.largest = 0;
		this.lastArrival = undefined;
		this.arrivalMs = this.arrivalMaxMs = 0;
		this.previousServiceMs = this.serviceSumMs = this.serviceMaxMs = this.servicedTransfers = 0;
		this.lastGapArrivalMs = this.lastGapPreviousServiceMs = 0;
		this.highestSequence = -1;
		this.outOfOrder = 0;
	}

	/** JS observes completion here; this is not a hardware USB timestamp. */
	observeArrival(nowMs: number, sequence: number): void {
		this.firstArrival ??= nowMs;
		this.arrivalMs = this.lastArrival === undefined ? 0 : Math.max(0, nowMs - this.lastArrival);
		this.arrivalMaxMs = Math.max(this.arrivalMaxMs, this.arrivalMs);
		this.lastArrival = nowMs;
		if (sequence < this.highestSequence) this.outOfOrder++;
		this.highestSequence = Math.max(this.highestSequence, sequence);
	}

	/** Synchronous header scanning, PCM conversion, FFT and dispatch time. */
	observeService(durationMs: number): void {
		this.previousServiceMs = Math.max(0, durationMs);
		this.serviceSumMs += this.previousServiceMs;
		this.serviceMaxMs = Math.max(this.serviceMaxMs, this.previousServiceMs);
		this.servicedTransfers++;
	}

	observe(data: DataView): void {
		this.transferCount++;
		this.receivedBytes += data.byteLength;
		this.receivedSamples += Math.floor(data.byteLength / STREAM_PKT_SIZE) * this.samplesPerPacket;
		this.lastTransferBytes = data.byteLength;
		for (let offset = 0; offset + STREAM_PKT_SIZE <= data.byteLength; offset += STREAM_PKT_SIZE) {
			const counter = data.getBigUint64(offset + 8, true);
			if (this.previous !== undefined) {
				const delta = (counter - this.previous) & COUNTER_MASK;
				if (delta > BigInt(this.samplesPerPacket) && delta < 1n << 63n) {
					const missing = Number(delta - BigInt(this.samplesPerPacket));
					this.gaps++;
					this.missing += missing;
					if (offset === 0) this.between++;
					else this.within++;
					this.largest = Math.max(this.largest, missing);
					this.lastGapArrivalMs = this.arrivalMs;
					this.lastGapPreviousServiceMs = this.previousServiceMs;
				} else if (delta !== BigInt(this.samplesPerPacket)) {
					// A reset, duplicate or backwards packet isn't evidence of lost samples.
					this.discontinuities++;
				}
			}
			this.previous = counter;
		}
	}

	get report(): RxStreamStats {
		return {
			sourceGapCount: this.gaps,
			sourceMissingSamples: this.missing,
			sourceDiscontinuities: this.discontinuities,
			sourceGapWithinTransfer: this.within,
			sourceGapBetweenTransfers: this.between,
			sourceLargestGapSamples: this.largest,
			sourceLastGapArrivalMs: this.lastGapArrivalMs,
			sourceLastGapPreviousServiceMs: this.lastGapPreviousServiceMs,
			usbArrivalMaxMs: this.arrivalMaxMs,
			usbServiceAvgMs: this.servicedTransfers ? this.serviceSumMs / this.servicedTransfers : 0,
			usbServiceMaxMs: this.serviceMaxMs,
			usbOutOfOrderTransfers: this.outOfOrder,
			usbLinkBits: this.linkBits,
			usbTransferBytes: this.transferBytes,
			usbDiagnosticMode: this.usbOnly ? 1 : 0,
			usbTransferCount: this.transferCount,
			usbReceivedBytes: this.receivedBytes,
			usbReceivedSamples: this.receivedSamples,
			usbElapsedMs: this.firstArrival === undefined ? 0 : (this.lastArrival ?? this.firstArrival) - this.firstArrival,
			usbLastTransferBytes: this.lastTransferBytes,
		};
	}
}
