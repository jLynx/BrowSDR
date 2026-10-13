import { decodeRs41Packet } from './rs41';
import { correctRs41 } from './error-correction';
import { Rs41Calibration } from './calibration';
import { decodeWeather } from './weather';
import { SONDE_LIMIT, SONDE_TTL, SONDE_TRAIL_LIMIT, type Radiosonde, type Rs41Packet } from './types';

export class SondeTracker {
	private sondes = new Map<string, Radiosonde>();
	private calibrations = new Map<string, Rs41Calibration>();
	frames = 0;
	crcErrors = 0;
	process(frame: Uint8Array, frequency: number, now = Date.now()): void {
		const packet = decodeRs41Packet(correctRs41(frame) ?? frame);
		const decoded = packet?.telemetry;
		if (!decoded?.id) {
			this.crcErrors++;
			return;
		}
		const previous = this.sondes.get(decoded.id);
		this.enrich(packet!, decoded.id, now);
		// Multiple clock phases can decode the same radio frame.
		const duplicate = previous && previous.frame === decoded.frame && now - previous.lastSeen < 1500;
		if (duplicate && !betterDuplicate(previous, decoded)) return;
		if (!duplicate) this.frames++;
		const sonde: Radiosonde = {
			id: decoded.id,
			model: 'RS41',
			frame: decoded.frame!,
			lastSeen: now,
			messages: 0,
			frequency,
			trail: [],
			...previous,
			...decoded,
		};
		sonde.lastSeen = now;
		sonde.frequency = frequency;
		if (!duplicate) sonde.messages++;
		if (decoded.latitude !== undefined && decoded.longitude !== undefined && decoded.altitude !== undefined) {
			sonde.maxAltitude = Math.max(sonde.maxAltitude ?? -Infinity, decoded.altitude);
			sonde.positionTime = now;
			sonde.trail = [
				...sonde.trail,
				{ latitude: decoded.latitude, longitude: decoded.longitude, altitude: decoded.altitude, time: now },
			].slice(-SONDE_TRAIL_LIMIT);
		}
		this.sondes.set(sonde.id, sonde);
		this.snapshot(now);
		if (this.sondes.size > SONDE_LIMIT) this.remove([...this.sondes.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0].id);
	}
	private enrich(packet: Rs41Packet, id: string, now: number): void {
		const decoded = packet.telemetry;
		let calibration = this.calibrations.get(id);
		if (!calibration) this.calibrations.set(id, (calibration = new Rs41Calibration()));
		calibration.update(packet.identity);
		const configuration = calibration.telemetry(now);
		// Countdown is a periodically transmitted reference, not refreshed by every frame.
		if (packet.identity[23] !== 50) {
			delete configuration.killCountdown;
			delete configuration.killCountdownTime;
		}
		Object.assign(decoded, configuration);
		const sensor = packet.blocks.get(0x7a) ?? packet.blocks.get(0x7f);
		if (sensor?.length === 42 || sensor?.length === 27) {
			const weather = decodeWeather(sensor, calibration, decoded.altitude);
			// A checked new measurement must not leave an older field looking current.
			for (const key of [
				'temperature',
				'humidity',
				'humiditySensorTemperature',
				'pressure',
				'estimatedPressure',
				'pressureSensorTemperature',
				'dewPoint',
				'weatherTime',
			] as const)
				decoded[key] = undefined;
			Object.assign(decoded, weather);
			if (weather.temperature !== undefined || weather.humidity !== undefined || weather.pressure !== undefined) decoded.weatherTime = now;
		}
	}
	private remove(id: string): void {
		this.sondes.delete(id);
		this.calibrations.delete(id);
	}
	snapshot(now = Date.now()): Radiosonde[] {
		for (const [id, sonde] of this.sondes) if (now - sonde.lastSeen > SONDE_TTL) this.remove(id);
		return [...this.sondes.values()].map((sonde) => ({ ...sonde, trail: [...sonde.trail] }));
	}
}

function betterDuplicate(previous: Radiosonde, decoded: Partial<Radiosonde>): boolean {
	return (
		(decoded.latitude !== undefined && previous.positionTime !== previous.lastSeen) ||
		(decoded.weatherTime !== undefined && previous.weatherTime !== previous.lastSeen) ||
		(decoded.rawBlocks?.filter((block) => block.crcValid).length ?? 0) > (previous.rawBlocks?.filter((block) => block.crcValid).length ?? 0)
	);
}
