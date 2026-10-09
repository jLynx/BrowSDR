import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import AdsbCacheControl from '@/app/decoders/adsb/cache-control';
import { offlineSnapshotState, snapshotManifest } from '@/app/decoders/adsb/database/snapshot';
import { saveOfflineDatabase } from '@/app/decoders/adsb/database/offline';

vi.mock('@/app/decoders/adsb/database/snapshot', () => ({ offlineSnapshotState: vi.fn(), snapshotManifest: vi.fn() }));
vi.mock('@/app/decoders/adsb/database/offline', () => ({ saveOfflineDatabase: vi.fn() }));
afterEach(() => {
	vi.resetAllMocks();
	vi.useRealTimers();
});

describe('offline database controls', () => {
	it('hides the button for a current database and offers an update after reconnecting', async () => {
		vi.mocked(snapshotManifest).mockResolvedValue({
			schema: 1,
			revision: 'a'.repeat(24),
			builtAt: '',
			files: {
				'aircraft-C8.db': { path: '', bytes: 90000000, count: 1, sha256: '' },
				'airlines.db': { path: '', bytes: 289108, count: 1, sha256: '' },
			},
		});
		vi.mocked(offlineSnapshotState).mockResolvedValueOnce('current').mockResolvedValueOnce('update').mockResolvedValue('current');
		const wrapper = mount(AdsbCacheControl);
		await flushPromises();
		expect(wrapper.find('button').exists()).toBe(false);
		window.dispatchEvent(new Event('online'));
		await flushPromises();
		expect(wrapper.find('button').text()).toBe('Update offline database (~91 MB)');
		vi.mocked(saveOfflineDatabase).mockResolvedValue();
		await wrapper.find('button').trigger('click');
		await flushPromises();
		expect(wrapper.find('button').exists()).toBe(false);
		expect(wrapper.find('[role="status"]').exists()).toBe(false);
		wrapper.unmount();
		const calls = vi.mocked(offlineSnapshotState).mock.calls.length;
		window.dispatchEvent(new Event('online'));
		expect(offlineSnapshotState).toHaveBeenCalledTimes(calls);
	});
	it('checks on opening without polling and checks again when reopened', async () => {
		vi.useFakeTimers();
		vi.mocked(offlineSnapshotState).mockResolvedValueOnce('current').mockResolvedValue('update');
		const wrapper = mount(AdsbCacheControl);
		await vi.advanceTimersByTimeAsync(0);
		expect(wrapper.find('button').exists()).toBe(false);
		await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
		expect(offlineSnapshotState).toHaveBeenCalledOnce();
		wrapper.unmount();
		const reopened = mount(AdsbCacheControl);
		await vi.advanceTimersByTimeAsync(0);
		expect(reopened.find('button').text()).toContain('Update offline database');
		expect(offlineSnapshotState).toHaveBeenCalledTimes(2);
		reopened.unmount();
	});
	it('offers the initial download and retains the action when saving fails', async () => {
		vi.mocked(offlineSnapshotState).mockResolvedValue('missing');
		vi.mocked(saveOfflineDatabase).mockRejectedValue(new Error('quota'));
		const wrapper = mount(AdsbCacheControl);
		await flushPromises();
		expect(wrapper.find('button').text()).toContain('Save offline database');
		await wrapper.find('button').trigger('click');
		await flushPromises();
		expect(wrapper.find('[role="status"]').text()).toContain('Could not save');
		expect(wrapper.find('button').attributes('disabled')).toBeUndefined();
		wrapper.unmount();
	});
});
