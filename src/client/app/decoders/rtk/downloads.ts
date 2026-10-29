import type { RtkMessage } from '@/worker/decoders/rtk/types';
import type { RtkReport } from './types';
import { stationKey } from '@/worker/decoders/rtk/station-key';

function save(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob),
		link = document.createElement('a');
	link.href = url;
	link.download = filename;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadReport(report: RtkReport): void {
	const body = JSON.stringify({ exportedAt: new Date().toISOString(), ...report }, null, 2);
	const source = report.stations.length === 1 ? `-${stationKey(report.stations[0])}` : '';
	save(new Blob([body], { type: 'application/json' }), `browsdr-rtk-${report.frequency.toFixed(6)}MHz${source}.json`);
}

export function downloadCorrections(frames: RtkMessage['rtcm'], frequency: number, source?: string): void {
	const bytes = new Uint8Array(frames.reduce((length, frame) => length + frame.data.length, 0));
	let offset = 0;
	for (const frame of frames) {
		bytes.set(frame.data, offset);
		offset += frame.data.length;
	}
	save(new Blob([bytes]), `browsdr-rtk-${frequency.toFixed(6)}MHz${source ? '-' + source : ''}.rtcm3`);
}
