import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { VfoParams } from '@/worker/runtime/types';
import type { PagerProtocol } from '@/worker/decoders/charsets';
import { PAGER_RX_BANDWIDTH, PAGER_LEG_PROTOCOLS } from '@/worker/decoders/pager-bandwidth';
import type { PagerLegIo } from './pager-legs.types';

/**
 * Independent FM channel legs, one per enabled pager protocol. Each is a DDC at
 * that protocol's own RX bandwidth (PAGER_RX_BANDWIDTH) so POCSAG/GSC/FLEX are
 * each filtered to the width their modulation needs instead of sharing the main
 * VFO bandwidth. Mirrors the rdsDdc pattern: created/freed as protocols toggle,
 * run per input chunk, and the demodulated 48 kHz audio is posted tagged with
 * the protocol so only that decoder consumes it (never playback or whisper).
 */
export class PagerLegs {
	private readonly legs: Partial<Record<PagerProtocol, DspProcessor>> = {};

	constructor(
		private readonly Processor: typeof DspProcessor,
		private readonly nfmIfRate: number,
		private readonly io: PagerLegIo,
	) {}

	/** Create / update / free legs for the current params. `offsetFreq` is the
	 * VFO's NCO offset in Hz (NFM, no sideband offset). Legs exist only for an
	 * enabled pager on an NFM VFO. */
	configure(params: VfoParams, systemSampleRate: number, offsetFreq: number): void {
		for (const proto of PAGER_LEG_PROTOCOLS) {
			const enabled = params.mode === 'nfm' && params[proto] === true;
			const leg = this.legs[proto];
			if (enabled) {
				const bw = PAGER_RX_BANDWIDTH[proto];
				if (!leg) {
					const created = new this.Processor(systemSampleRate, offsetFreq, bw);
					created.set_if_sample_rate(this.nfmIfRate);
					this.legs[proto] = created;
				} else {
					leg.set_shift(systemSampleRate, offsetFreq);
					leg.set_bandwidth(bw);
				}
			} else if (leg) {
				leg.free();
				delete this.legs[proto];
			}
		}
	}

	/** Re-tune every active leg's NCO (center-frequency change). */
	setShift(systemSampleRate: number, offsetFreq: number): void {
		for (const proto of PAGER_LEG_PROTOCOLS) {
			this.legs[proto]?.set_shift(systemSampleRate, offsetFreq);
		}
	}

	/** Free all legs (sample-rate change / teardown). */
	freeAll(): void {
		for (const proto of PAGER_LEG_PROTOCOLS) {
			const leg = this.legs[proto];
			if (leg) {
				leg.free();
				delete this.legs[proto];
			}
		}
	}

	/**
	 * Demodulate each active leg to 48 kHz audio and post it tagged for its
	 * decoder, reading the shared WASM buffers through the bound IO context.
	 */
	process(chunkLen: number, chunkId: number): void {
		const io = this.io;
		const inputIsFloat = io.inputIsFloat();
		for (const proto of PAGER_LEG_PROTOCOLS) {
			const leg = this.legs[proto];
			if (!leg) continue;
			let outPtr: number;
			try {
				outPtr = inputIsFloat ? leg.process_f32_ptr(io.floatPtr(), chunkLen) : leg.process_ptr(io.iqPtr(), chunkLen);
			} catch (err) {
				io.onError(err instanceof Error ? err.message : String(err), chunkId);
				continue;
			}
			const numAudioSamples = leg.get_output_len();
			if (numAudioSamples === 0) continue;
			const result = new Float32Array(io.wasmMemory(), outPtr, numAudioSamples);
			for (let i = 0; i < numAudioSamples; i++) {
				if (result[i] > 1.0) result[i] = 1.0;
				else if (result[i] < -1.0) result[i] = -1.0;
			}
			const cloneOut = result.slice();
			io.post(
				{
					type: 'audio',
					pager: proto,
					samples: cloneOut.buffer,
					channels: 1,
					chunkId,
					// Pager audio is continuous; only untagged main-channel buffers
					// update VFO squelch/RX activity in the receiving handlers.
					squelchOpen: false,
					squelchDb: leg.get_squelch_db(),
					dspTime: 0,
				},
				[cloneOut.buffer],
			);
		}
	}
}
