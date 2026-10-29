import type { RtkReception } from './types';

export function correctionAge(lastCorrection: number | undefined, now: number): string {
	if (lastCorrection === undefined || !Number.isFinite(lastCorrection)) return 'No verified corrections yet';
	const seconds = Math.max(0, Math.floor((now - lastCorrection) / 1000));
	if (seconds < 60) return `${seconds} s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} m ${seconds % 60} s ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ${minutes % 60} m ago`;
	return `${Math.floor(hours / 24)} d ${hours % 24} h ago`;
}

export function receptionState(value: RtkReception): { label: string; detail: string; tone: string } {
	if (!value.local) return { label: 'Local SDR required', detail: 'Connect an SDR to this browser to decode RTK signals.', tone: 'idle' };
	if (!value.running) return { label: 'Reception stopped', detail: 'Connect the SDR and start radio reception.', tone: 'idle' };
	if (!value.enabled) return { label: 'Decoder off', detail: 'Enable Decode to read this channel. Audio can stay muted.', tone: 'idle' };
	if (!value.inBand)
		return { label: 'Outside received band', detail: 'Adjust the radio centre frequency to include this channel.', tone: 'warning' };
	if (value.status?.state === 'error') return { label: 'Needs attention', detail: value.status.message, tone: 'warning' };
	if (value.station?.lastCorrection && value.now - value.station.lastCorrection < 5000)
		return { label: 'Live corrections', detail: 'Receiving verified correction data from this base.', tone: 'live' };
	if (value.station) return { label: 'Waiting for corrections', detail: 'Showing the last received base data.', tone: 'idle' };
	if (value.status?.beacons)
		return { label: 'Verified beacons', detail: 'RTK3 base beacons received. Waiting for verified corrections.', tone: 'idle' };
	if (value.status?.packets && value.status.containers !== undefined)
		return {
			label: 'Verified radio frames',
			detail: 'RTK3 frames received. Waiting for complete, verified RTCM corrections.',
			tone: 'idle',
		};
	if (value.status?.payloads)
		return {
			label: 'Payload unverified',
			detail: 'LoRa payload bytes recovered. Their format, checksums and base identity are not yet verified.',
			tone: 'warning',
		};
	if (value.status?.headers)
		return {
			label: 'Payload undecoded',
			detail: 'LoRa radio packets detected. Their contents and base identity are not yet verified.',
			tone: 'warning',
		};
	return { label: 'Listening', detail: 'Waiting for a decodable RTK signal on this channel.', tone: 'idle' };
}
