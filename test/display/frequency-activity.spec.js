import { describe, expect, it } from 'vitest';
import { computedProperties } from '../../src/client/app/core/computed';

const activity = (state) => computedProperties.sortedVfoActivity.call(state);

describe('frequency activity ranking', () => {
	it('includes DSD without squelch and ranks decoded voice alongside analog activity', () => {
		const rows = activity({
			activityNow: 5000,
			vfos: [
				{ mode: 'dsd', squelchEnabled: false },
				{ mode: 'dsd', squelchEnabled: true },
				{ mode: 'nfm', squelchEnabled: true },
				{ mode: 'nfm', squelchEnabled: false },
			],
			vfoActivityStats: [
				{ count: 2, totalMs: 2000, squelchOpenSince: 4000 },
				{ count: 0, totalMs: 0, squelchOpenSince: null },
				{ count: 1, totalMs: 1500, squelchOpenSince: null },
				{ count: 10, totalMs: 10000, squelchOpenSince: null },
			],
		});
		expect(rows.map((row) => row.index)).toEqual([0, 2, 1]);
		expect(rows[0]).toMatchObject({ count: 2, totalMs: 3000, isLive: true, pct: 100 });
		expect(rows[1]).toMatchObject({ totalMs: 1500, isLive: false, pct: 50 });
		expect(rows[2]).toMatchObject({ count: 0, totalMs: 0, isLive: false });
	});
	it('shows quiet DSD channels without inventing activity after reset', () => {
		const rows = activity({ activityNow: 5000, vfos: [{ mode: 'dsd', squelchEnabled: false }], vfoActivityStats: [] });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ count: 0, totalMs: 0, isLive: false, pct: 0 });
	});
});
