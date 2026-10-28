import type { RtcmObservation } from './types';

/** Publish one MSM observation sequence, joining same-epoch constellation fragments. */
export class RtkObservations {
	private pending: Record<string, RtcmObservation> = {};
	private interrupted = false;
	private lastSeen = 0;

	process(observation: RtcmObservation): Record<string, RtcmObservation> | undefined {
		if (this.interrupted) {
			if (!observation.multipleMessage) this.interrupted = false;
			return;
		}
		const previous = this.pending[observation.constellation];
		if (
			observation.receivedAt - this.lastSeen > 5000 ||
			(previous &&
				(previous.epochMs !== observation.epochMs || previous.day !== observation.day || previous.stationId !== observation.stationId))
		)
			this.pending = {};
		this.lastSeen = observation.receivedAt;
		const part = this.pending[observation.constellation];
		this.pending[observation.constellation] = part ? merge(part, observation) : observation;
		if (observation.multipleMessage) return;
		const complete = this.pending;
		this.pending = {};
		return complete;
	}

	discontinuity(): void {
		this.pending = {};
		// A missing radio fragment may contain the beginning of an MSM sequence.
		this.interrupted = true;
	}
}

function merge(first: RtcmObservation, last: RtcmObservation): RtcmObservation {
	const cells = new Map(
		[...(first.measurements ?? []), ...(last.measurements ?? [])].map((cell) => [`${cell.satellite}:${cell.signal}`, cell]),
	);
	const measurements = [...cells.values()];
	return {
		...last,
		satellites: [...new Set([...first.satellites, ...last.satellites])].sort((a, b) => a - b),
		signals: [...new Set([...first.signals, ...last.signals])].sort((a, b) => a - b),
		cells: measurements.length,
		measurements,
		cnrDbHz: measurements.map((cell) => cell.cnrDbHz),
	};
}
