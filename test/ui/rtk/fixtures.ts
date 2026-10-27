import type { RtkMessage, RtkStation } from '@/worker/decoders/rtk/types';

export function mockStation(scan = 1234, longitude = 0): RtkStation {
	return {
		name: 'MOCK GNSS',
		scan,
		channel: 7,
		netId: 42,
		packets: 1,
		lastSeen: Date.now(),
		lastCorrection: Date.now(),
		rtcmCount: 1,
		rtcmTypes: { 1006: 1 },
		cfoHz: 0,
		reference: { stationId: 42, itrf: 0, latitude: 0, longitude, heightM: 0, ecef: [1, 2, 3] },
	};
}

export function mockStationMessage(frequency: number, stations: RtkStation[]): RtkMessage {
	return {
		type: 'rtk',
		freq: frequency,
		stations,
		status: {
			state: 'receiving',
			message: 'Listening',
			samples: 1000,
			syncs: 1,
			headers: 1,
			packets: stations.length,
			crcErrors: 0,
			discontinuities: 0,
		},
		rtcm: stations.map((station, index) => ({
			type: 1006,
			stationId: 42,
			source: `${station.scan}.${station.channel}.${station.netId}`,
			data: new Uint8Array([0xd3, index]),
		})),
	};
}
