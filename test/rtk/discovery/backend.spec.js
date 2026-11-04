import { describe, expect, it, vi } from 'vitest';
import { Backend } from '@/worker/runtime/backend';

describe('RTK activity hint routing', () => {
	it('updates only scout workers without reconfiguring their VFOs, and rejects stale receive bands', () => {
		const workers = Array.from({ length: 3 }, () => ({ postMessage: vi.fn() }));
		const backend = {
			_centerFreq: 921.5,
			_sampleRate: 20000000,
			vfoParams: [
				{ rtk: true, rtkProfile: 'scan' },
				{ rtk: true, rtkProfile: 'auto' },
				{ rtk: false, rtkProfile: 'scan' },
			],
			dspWorkers: workers,
		};
		Backend.prototype.setRtkDiscoveryCandidates.call(backend, [919.173], 921.5, 20000000);
		expect(workers[0].postMessage).toHaveBeenCalledWith({
			type: 'rtk_candidates',
			frequenciesMHz: [919.173],
			centerFreq: 921.5,
			sampleRate: 20000000,
		});
		expect(workers[1].postMessage).not.toHaveBeenCalled();
		expect(workers[2].postMessage).not.toHaveBeenCalled();
		Backend.prototype.setRtkDiscoveryCandidates.call(backend, [919.173], 922, 20000000);
		Backend.prototype.setRtkDiscoveryCandidates.call(backend, [919.173], 921.5, 10000000);
		expect(workers[0].postMessage).toHaveBeenCalledTimes(1);
	});
});
