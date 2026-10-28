import type { RtkIdentity } from './types';

export function stationKey(station: RtkIdentity): string {
	if (station.address !== undefined) return `rtk3-${station.address}`;
	return `${station.scan}.${station.channel}.${station.netId}`;
}
