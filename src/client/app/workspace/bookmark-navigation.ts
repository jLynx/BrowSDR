import type { AppInstance } from '@/app/core/receiver.types';
import type { Vfo } from '@/app/core/types';
import { computedProperties } from '@/app/core/computed';
import { isValidDisplayFrequencyMhz } from '@/radio/frequency-shift';
import type { Bookmark } from './types';

// Track each VFO separately, including bookmarks sharing the same frequency.
const cursors = new WeakMap<Vfo, Bookmark>();

/** Follow the sidebar's category/frequency order, including search filtering and wrapping. */
export async function cycleIndividualBookmark(receiver: AppInstance, direction: -1 | 1): Promise<void> {
	const vfo = receiver.vfos[receiver.activeVfoIndex];
	if (!vfo) return;
	const { categories } = computedProperties.bookmarkGroupsByCategory.call(receiver);
	const entries = categories.flatMap((category) => category.items).filter(({ bm }) => canRecall(receiver, bm));
	if (!entries.length) {
		receiver.showMsg('No matching frequency bookmarks available');
		return;
	}
	const cursor = cursors.get(vfo);
	let current = entries.findIndex(({ bm }) => bm === cursor && bm.freq === vfo.freq);
	if (current < 0) current = entries.findIndex(({ bm }) => bm.freq === vfo.freq);
	const next = current < 0 ? (direction === 1 ? 0 : entries.length - 1) : (current + direction + entries.length) % entries.length;
	const { bm, i } = entries[next];
	await receiver.jumpToBookmark(i);
	cursors.set(vfo, bm);
}

function canRecall(receiver: AppInstance, bookmark: Bookmark): boolean {
	if (bookmark.freq === undefined || !isValidDisplayFrequencyMhz(bookmark.freq, receiver.radio.frequencyShift)) return false;
	// The existing recall action recentres bookmarks outside the visible span.
	// Recorded IQ and host-locked tuning cannot accept that change.
	if (receiver.iqReplay || (receiver.remoteMode === 'client' && receiver.locks.centerFreq)) {
		return bookmark.freq >= receiver.minFreq && bookmark.freq <= receiver.maxFreq;
	}
	return true;
}
