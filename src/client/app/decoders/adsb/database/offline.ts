import type { DatabaseFormat } from './types';
import { snapshotOfflineAvailable, saveSnapshot } from './snapshot';

export const AIRCRAFT_FORMAT: DatabaseFormat = { keySize: 7, fieldSizes: [9, 33, 33, 5, 33, 33] };
export const AIRLINE_FORMAT: DatabaseFormat = { keySize: 4, fieldSizes: [32, 32] };
let download: Promise<void> | undefined;

export function offlineDatabaseAvailable(): Promise<boolean> {
	return snapshotOfflineAvailable();
}

async function save(onStatus: (status: string) => void): Promise<void> {
	if (!(await saveSnapshot(onStatus))) throw new Error('Aircraft database unavailable. Check your internet connection and retry.');
}

export function saveOfflineDatabase(onStatus: (status: string) => void): Promise<void> {
	if (download) return download;
	download = save(onStatus).finally(() => {
		download = undefined;
	});
	return download;
}
