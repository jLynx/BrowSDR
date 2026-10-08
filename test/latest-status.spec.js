import { afterEach, describe, expect, it, vi } from 'vitest';
import { LatestStatus } from '@/worker/runtime/latest-status';

afterEach(() => vi.useRealTimers());

describe('decoder status coalescing', () => {
	it('limits burst updates and delivers the final snapshot after input stops', () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
		const send = vi.fn();
		const updates = new LatestStatus(send);
		updates.push({ syncCount: 1 });
		for (let syncCount = 2; syncCount <= 100; syncCount++) updates.push({ syncCount });
		expect(send).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(200);
		expect(send).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenLastCalledWith({ syncCount: 100 });
		vi.advanceTimersByTime(1000);
		expect(send).toHaveBeenCalledTimes(2);
	});
	it('copies pending status and cancels old snapshots on reset', () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
		const send = vi.fn();
		const updates = new LatestStatus(send);
		updates.push({ synced: true });
		const status = { synced: false };
		updates.push(status);
		status.synced = true;
		vi.advanceTimersByTime(200);
		expect(send).toHaveBeenLastCalledWith({ synced: false });
		updates.push({ synced: true });
		updates.reset();
		updates.push({ synced: false, syncCount: 0 });
		vi.advanceTimersByTime(200);
		expect(send).toHaveBeenCalledTimes(3);
		expect(send).toHaveBeenLastCalledWith({ synced: false, syncCount: 0 });
	});
});
