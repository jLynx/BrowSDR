import { isRecord } from '@/platform/data';
import type { BandwidthSnapshot, BandwidthSource, BandwidthCounter } from './bandwidth.types';

export function emptyBandwidth(): BandwidthSnapshot {
	return { uploadBps: 0, downloadBps: 0, peers: 0, ready: false, unavailable: false };
}

/** One sampler per shared connection, irrespective of receiver or subscriber count. */
export class BandwidthMonitor {
	private listeners = new Set<(snapshot: BandwidthSnapshot) => void>();
	private previous = new Map<RTCPeerConnection, Map<string, BandwidthCounter>>();
	private snapshot = emptyBandwidth();
	private timer?: ReturnType<typeof setInterval>;
	private pending = false;
	private generation = 0;
	private closed = false;

	constructor(private source: BandwidthSource) {}

	subscribe(listener: (snapshot: BandwidthSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.snapshot);
		if (!this.closed && this.timer === undefined) {
			this.timer = setInterval(() => void this.sample(), 1000);
			void this.sample();
		}
		return () => {
			this.listeners.delete(listener);
			if (!this.listeners.size) this.stop();
		};
	}

	close(): void {
		this.closed = true;
		this.stop();
		this.publish({ ...emptyBandwidth(), ready: true });
		this.listeners.clear();
	}

	private stop(): void {
		clearInterval(this.timer);
		this.timer = undefined;
		this.generation++;
		this.previous.clear();
		this.snapshot = emptyBandwidth();
	}

	private publish(snapshot: BandwidthSnapshot): void {
		this.snapshot = snapshot;
		for (const listener of this.listeners) listener(snapshot);
	}

	private async sample(): Promise<void> {
		if (this.pending || this.closed) return;
		this.pending = true;
		const generation = this.generation;
		try {
			const { connections, peers } = activeConnections(this.source);
			const samples = await Promise.all([...connections].map(async (pc) => ({ pc, counters: await readCounters(pc) })));
			if (generation !== this.generation || this.closed) return;
			const snapshot = { ...emptyBandwidth(), peers, ready: true };
			const next = new Map<RTCPeerConnection, Map<string, BandwidthCounter>>();
			for (const { pc, counters } of samples) {
				if (!counters) {
					snapshot.unavailable = true;
					continue;
				}
				next.set(pc, counters);
				for (const [id, counter] of counters) {
					const before = this.previous.get(pc)?.get(id);
					if (!before) {
						snapshot.ready = false; // Wait for every stream before displaying an aggregate total.
						continue;
					}
					const elapsed = (counter.time - before.time) / 1000;
					if (elapsed <= 0 || counter.sent < before.sent || counter.received < before.received) {
						snapshot.ready = false;
						continue;
					}
					snapshot.uploadBps += (counter.sent - before.sent) / elapsed;
					snapshot.downloadBps += (counter.received - before.received) / elapsed;
				}
			}
			this.previous = next;
			this.publish(snapshot);
		} finally {
			this.pending = false;
		}
	}
}

function activeConnections(source: BandwidthSource) {
	const connections = new Set<RTCPeerConnection>();
	const groups = source.isHost ? [...source.clients.values()] : [{ cmd: source.connCmd, fft: source.connFft, audio: source.connAudio }];
	let peers = 0;
	for (const group of groups) {
		const active = [group.cmd, group.fft, group.audio].filter((conn) => conn?.open && conn.peerConnection);
		if (active.length) peers++;
		for (const conn of active) if (conn?.peerConnection) connections.add(conn.peerConnection);
	}
	return { connections, peers };
}

async function readCounters(pc: RTCPeerConnection): Promise<Map<string, BandwidthCounter> | null> {
	try {
		const report = await pc.getStats();
		const counters = new Map<string, BandwidthCounter>();
		for (const [, value] of report) {
			const stat: unknown = value;
			if (
				isRecord(stat) &&
				stat.type === 'transport' &&
				typeof stat.id === 'string' &&
				validCounter(stat.timestamp) &&
				validCounter(stat.bytesSent) &&
				validCounter(stat.bytesReceived)
			)
				counters.set(stat.id, { time: stat.timestamp, sent: stat.bytesSent, received: stat.bytesReceived });
		}
		return counters.size ? counters : null;
	} catch {
		return null; // Closing peers and browsers without transport counters are expected.
	}
}

function validCounter(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
