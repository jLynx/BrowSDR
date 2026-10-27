import type { RtcmReference, RtcmObservation, RtkStation } from '@/worker/decoders/rtk/types';

export function validBasePosition(reference: RtcmReference | undefined): reference is RtcmReference {
	return (
		!!reference &&
		Number.isFinite(reference.latitude) &&
		Number.isFinite(reference.longitude) &&
		Math.abs(reference.latitude) <= 90 &&
		Math.abs(reference.longitude) <= 180
	);
}

export function referencePosition(reference: RtcmReference): string {
	return `${reference.latitude.toFixed(7)}°, ${reference.longitude.toFixed(7)}°`;
}

export function loraNumber(station: RtkStation): string {
	// The supported radio wrapper exposes three of the four Mammotion pairing fields.
	return `${station.scan}.${station.channel}.?.${station.netId}`;
}

export function observedSatellites(station: RtkStation, now: number): number {
	return Object.values(station.observations ?? {})
		.filter((observation) => now - observation.receivedAt < 5000)
		.reduce((total, observation) => total + observation.satellites.length, 0);
}

export function signalStrength(observation: RtcmObservation): string {
	const values = observation.cnrDbHz.filter((value) => value > 0);
	return values.length
		? `${(values.reduce((total, value) => total + value, 0) / values.length).toFixed(1)} dB-Hz mean C/N₀`
		: 'C/N₀ unavailable';
}
