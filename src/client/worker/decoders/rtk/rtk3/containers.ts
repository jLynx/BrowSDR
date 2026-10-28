import { validRtcmFrame } from '@/worker/decoders/rtk/rtcm-frame';
import type { Rtk3Container } from './types';

const MAGIC = [0xa5, 0x5a, 0x04, 0x01, 0x04];
const HEADER = 10;
const MAX_LENGTH = 1029;

/** Bounded stream assembler; only stripped, CRC16-verified data bodies enter. */
export class Rtk3Containers {
	private partial = new Uint8Array(0);
	private sequence?: number;
	readonly counters = { containers: 0, containerErrors: 0, sequenceGaps: 0 };

	process(body: Uint8Array, onContainer: (container: Rtk3Container) => void, onDiscontinuity: () => void): void {
		const data = new Uint8Array(this.partial.length + body.length);
		data.set(this.partial);
		data.set(body, this.partial.length);
		let offset = 0;
		while (offset + HEADER <= data.length) {
			if (!MAGIC.every((byte, i) => data[offset + i] === byte)) {
				offset++;
				continue;
			}
			const type = data[offset + 5];
			const length = data[offset + 6] | (data[offset + 7] << 8);
			if (type > 1 || length < 1 || length > MAX_LENGTH) {
				offset++;
				continue;
			}
			if (type === 1 && offset + HEADER < data.length && data[offset + HEADER] !== 0xd3) {
				offset++;
				continue;
			}
			const end = offset + HEADER + length;
			if (end > data.length) break;
			const payload = data.subarray(offset + HEADER, end);
			if (type === 1 && !validRtcmFrame(payload)) {
				this.counters.containerErrors++;
				onDiscontinuity();
				offset++;
				continue;
			}
			const sequence = data[offset + 8] | (data[offset + 9] << 8);
			this.accept({ type, sequence, payload }, onContainer, onDiscontinuity);
			offset = end;
		}
		this.partial = data.slice(offset);
	}

	private accept(container: Rtk3Container, onContainer: (container: Rtk3Container) => void, onDiscontinuity: () => void): void {
		if (this.sequence !== undefined) {
			const delta = (container.sequence - this.sequence + 65536) % 65536;
			if (delta === 0) return;
			if (delta !== 1) onDiscontinuity();
			if (delta > 1 && delta < 32768) this.counters.sequenceGaps += delta - 1;
		}
		this.sequence = container.sequence;
		this.counters.containers++;
		onContainer(container);
	}

	reset(resetSequence = false): void {
		this.partial = new Uint8Array(0);
		if (resetSequence) this.sequence = undefined;
	}
}
