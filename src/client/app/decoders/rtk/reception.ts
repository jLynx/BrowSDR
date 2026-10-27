import type { RtkReception } from './types';

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
	if (value.status?.headers)
		return {
			label: 'Payload undecoded',
			detail: 'LoRa radio packets detected. Their contents and base identity are not yet verified.',
			tone: 'warning',
		};
	return { label: 'Listening', detail: 'Waiting for a decodable RTK signal on this channel.', tone: 'idle' };
}
