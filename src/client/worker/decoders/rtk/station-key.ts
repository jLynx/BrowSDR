import type { RtkIdentity } from './types';

export function stationKey(station: RtkIdentity): string {
	if (station.protocol === 'rtk2') return `rtk2-${station.network}-${station.address}`;
	if (station.address !== undefined)
		return station.addressPrefix ? `rtk3-${station.addressPrefix}-${station.address}` : `rtk3-${station.address}`;
	return `${station.scan}.${station.channel}.${station.netId}`;
}
