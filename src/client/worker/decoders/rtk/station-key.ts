import type { RtkStation } from './types';

export function stationKey(station: Pick<RtkStation, 'scan' | 'channel' | 'netId'>): string {
	return `${station.scan}.${station.channel}.${station.netId}`;
}
