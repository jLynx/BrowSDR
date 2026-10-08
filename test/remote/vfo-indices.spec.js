import { afterEach, describe, expect, it, vi } from 'vitest';
import * as remoteBackend from '@/worker/streams/remote-clients';
import { remoteMethods } from '@/app/workspace/remote';
import { makeDefaultVfo } from '@/app/core/constants';

vi.mock('@/worker/runtime/wasm-init', () => ({ ensureWasmInitialized: vi.fn(), init: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

function makeBackend() {
	vi.stubGlobal(
		'Worker',
		class {
			postMessage = vi.fn();
			terminate = vi.fn();
		},
	);
	const backend = { _sampleRate: 2000000, _centerFreq: 100, sharedIqPools: [new ArrayBuffer(32)] };
	for (const [name, method] of Object.entries(remoteBackend)) backend[name] = method.bind(backend);
	return backend;
}

describe('allocated remote VFO indices', () => {
	it.each([-1, 0.5, 1, 1000000000])('rejects update and removal at unallocated index %s without mutating arrays', async (index) => {
		const backend = makeBackend();
		await backend.addRemoteClient('alice');
		await backend.setRemoteVfoParams('alice', 0, makeDefaultVfo());
		const state = backend._remoteClients.get('alice');
		const before = Object.fromEntries(
			Object.entries(state)
				.filter(([, value]) => Array.isArray(value))
				.map(([key, value]) => [key, value.slice()]),
		);
		expect(await backend.setRemoteVfoParams('alice', index, makeDefaultVfo(106))).toBe(false);
		expect(await backend.removeRemoteVfo('alice', index)).toBe(false);
		for (const [key, value] of Object.entries(before)) expect(state[key]).toEqual(value);
		expect(state.workers[0].terminate).not.toHaveBeenCalled();
	});
	it('allocates VFO 0 at connection, requires explicit additions, and ignores stale peers', async () => {
		const backend = makeBackend();
		expect(await backend.setRemoteVfoParams('unknown', 0, makeDefaultVfo())).toBe(false);
		expect(backend._remoteClients).toBeUndefined();
		await backend.addRemoteClient('alice');
		expect(await backend.setRemoteVfoParams('alice', 0, makeDefaultVfo())).toBe(true);
		await backend.addRemoteVfo('alice');
		expect(await backend.setRemoteVfoParams('alice', 1, makeDefaultVfo(106))).toBe(true);
		expect(await backend.removeRemoteVfo('alice', 0)).toBe(true);
		expect(backend._remoteClients.get('alice').params.map((params) => params.freq)).toEqual([106]);
		await backend.removeRemoteClient('alice');
		expect(await backend.setRemoteVfoParams('alice', 0, makeDefaultVfo())).toBe(false);
		expect(await backend.removeRemoteVfo('alice', 0)).toBe(false);
		expect(backend._remoteClients.size).toBe(0);
	});
	it.each([-1, 0.5, 1, 1000000000])('keeps the host UI count when the backend rejects removal at %s', async (index) => {
		const backend = makeBackend();
		await backend.addRemoteClient('alice');
		const host = { remoteMode: 'host', backend, remoteClients: [{ id: 'alice', vfoCount: 1 }] };
		remoteMethods.handleRemoteCommand.call(host, 'alice', { type: 'removeRemoteVfo', index });
		await Promise.resolve();
		expect(host.remoteClients[0].vfoCount).toBe(1);
		remoteMethods.handleRemoteCommand.call(host, 'alice', { type: 'removeRemoteVfo', index: 0 });
		await Promise.resolve();
		expect(host.remoteClients[0].vfoCount).toBe(0);
	});
});
