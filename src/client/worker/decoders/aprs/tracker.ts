import { decodeAx25 } from './ax25';
import { decodePacket, telemetryDefinition } from './packets';
import {
	APRS_PACKET_LIMIT,
	APRS_STATION_LIMIT,
	APRS_STATION_TTL,
	APRS_TRAIL_LIMIT,
	type AprsPacket,
	type AprsReport,
	type AprsStation,
	type AprsTelemetryDefinition,
} from './types';

// Digipeaters retransmit the same packet within seconds; APRS-IS uses the same 30 s duplicate window.
const DUPLICATE_WINDOW = 30000;

export class AprsTracker {
	frames = 0;
	private sequence = 0;
	private stations = new Map<string, AprsStation>();
	private packets: AprsPacket[] = [];
	private definitions = new Map<string, AprsTelemetryDefinition>();
	private recent = new Map<string, number>();

	/** Returns false when the frame is not valid AX.25. */
	process(frame: Uint8Array, now = Date.now()): boolean {
		const ax25 = decodeAx25(frame);
		if (!ax25) return false;
		this.frames++;
		const decoded = decodePacket(ax25);
		const key = `${decoded.source}>${decoded.info}`;
		const duplicate = now - (this.recent.get(key) ?? -Infinity) < DUPLICATE_WINDOW;
		if (!duplicate) this.remember(key, now);
		const packet: AprsPacket = { ...decoded, id: ++this.sequence, receivedAt: now, ...(duplicate ? { duplicate } : {}) };
		this.packets.push(packet);
		if (this.packets.length > APRS_PACKET_LIMIT) this.packets.shift();
		this.update(packet, now);
		return true;
	}

	private remember(key: string, now: number): void {
		this.recent.set(key, now);
		if (this.recent.size > 1000) for (const [item, time] of this.recent) if (now - time >= DUPLICATE_WINDOW) this.recent.delete(item);
	}

	private update(packet: AprsPacket, now: number): void {
		const station = this.station(packet.source, 'station', now);
		station.lastSeen = now;
		if (packet.duplicate) return;
		station.packets++;
		station.destination = packet.destination;
		station.path = packet.path.join(',');
		if (packet.message?.kind === 'telemetry-definition') this.define(packet.message.addressee, packet.message.text);
		if (packet.kind === 'object' || packet.kind === 'item') {
			const target = this.station(packet.name!, packet.kind, now);
			target.owner = packet.source;
			target.killed = packet.killed;
			target.lastSeen = now;
			target.packets++;
			apply(target, packet, now);
		} else apply(station, packet, now);
	}

	private station(id: string, type: AprsStation['type'], now: number): AprsStation {
		const key = `${type}:${id}`;
		let station = this.stations.get(key);
		if (!station) {
			station = { id, type, lastSeen: now, packets: 0, trail: [] };
			this.stations.set(key, station);
			if (this.stations.size > APRS_STATION_LIMIT) {
				const oldest = [...this.stations.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0][0];
				this.stations.delete(oldest);
			}
		}
		return station;
	}

	private define(addressee: string, text: string): void {
		const definition = telemetryDefinition(text);
		if (!definition) return;
		this.definitions.set(addressee, { ...this.definitions.get(addressee), ...definition });
		if (this.definitions.size > APRS_STATION_LIMIT) this.definitions.delete(this.definitions.keys().next().value!);
	}

	snapshot(now = Date.now()): { stations: AprsStation[]; packets: AprsPacket[] } {
		for (const [key, station] of this.stations) if (now - station.lastSeen > APRS_STATION_TTL) this.stations.delete(key);
		const stations = [...this.stations.values()].map((station) => {
			const definition = station.type === 'station' ? this.definitions.get(station.id) : undefined;
			return { ...station, trail: [...station.trail], ...(definition ? { telemetryDefinition: definition } : {}) };
		});
		return { stations, packets: this.packets.map((packet) => ({ ...packet })) };
	}
}

function apply(station: AprsStation, report: AprsReport, now: number): void {
	if (report.symbol) station.symbol = report.symbol;
	if (report.latitude !== undefined && report.longitude !== undefined) locate(station, report, now);
	if (report.comment && ['position', 'weather', 'object', 'item'].includes(report.kind)) station.comment = report.comment;
	if (report.messaging !== undefined) station.messaging = report.messaging;
	if (report.micEStatus) station.micEStatus = report.micEStatus;
	if (report.phg) station.phg = report.phg;
	if (report.range !== undefined) station.range = report.range;
	if (report.status !== undefined) {
		station.status = report.status;
		station.statusTime = now;
	}
	if (report.weather) {
		station.weather = report.weather;
		station.weatherTime = now;
	}
	if (report.telemetry) {
		station.telemetry = report.telemetry;
		station.telemetryTime = now;
	}
}

function locate(station: AprsStation, report: AprsReport, now: number): void {
	const latitude = report.latitude!;
	const longitude = report.longitude!;
	station.latitude = latitude;
	station.longitude = longitude;
	station.ambiguity = report.ambiguity;
	station.positionTime = now;
	// Motion and altitude describe this report; omitted values are unknown rather than unchanged.
	station.course = report.course;
	station.speed = report.speed;
	station.altitude = report.altitude;
	const last = station.trail.at(-1);
	if (!last || last.latitude !== latitude || last.longitude !== longitude)
		station.trail = [...station.trail, { latitude, longitude, time: now }].slice(-APRS_TRAIL_LIMIT);
}
