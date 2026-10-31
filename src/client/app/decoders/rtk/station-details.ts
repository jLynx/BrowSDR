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
	if (station.protocol === 'rtk2' && station.loc !== undefined) return `?.?.${station.loc}.${station.address}`;
	if (station.addressPrefix) return `header ${station.addressPrefix}:${station.address}`;
	if (station.address !== undefined) return `address ${station.address}`;
	// The supported radio wrapper exposes three of the four Mammotion pairing fields.
	return `${station.scan}.${station.channel}.?.${station.netId}`;
}

export function loraPairingDetails(station: RtkStation): { label: string; title: string; unknown?: string } {
	if (station.protocol === 'rtk2' && station.loc !== undefined)
		return {
			label: 'LoRa number',
			title: 'scan.channel.loc.net · Loc and net are verified; scan and channel are not present in the correction header.',
			unknown: 'scan/channel unknown',
		};
	if (station.addressPrefix)
		return {
			label: 'LoRa station address',
			title: 'Two 16-bit words from verified RTK3 radio frames; the first word’s meaning is unknown.',
		};
	return station.address !== undefined
		? { label: 'LoRa station address', title: '16-bit address from verified radio frames.' }
		: { label: 'LoRa number', title: 'scan.channel.loc.net · The loc field has not been decoded.', unknown: 'loc unknown' };
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
