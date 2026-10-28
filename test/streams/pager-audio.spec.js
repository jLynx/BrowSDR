import { afterEach, describe, expect, it, vi } from 'vitest';
import { PagerLegs } from '@/worker/streams/pager-legs';
import { installWorkerAudioHandler } from '@/worker/streams/local-audio';
import * as remoteBackend from '@/worker/streams/remote-clients';

vi.mock('@/worker/runtime/wasm-init', () => ({ ensureWasmInitialized: vi.fn(), init: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

class QuietProcessor {
	set_if_sample_rate() {}
	process_f32_ptr() {
		return 0;
	}
	get_output_len() {
		return 960;
	}
	get_squelch_db() {
		return -120;
	}
}
const audio = (open, pager) => ({
	type: 'audio',
	samples: new Float32Array(960).buffer,
	channels: 1,
	squelchOpen: open,
	squelchDb: open ? -50 : -120,
	dspTime: 0,
	pager,
});

describe('pager audio isolation', () => {
	it.each(['pocsag', 'gsc', 'flex'])('keeps local main-channel squelch state independent of %s audio', (protocol) => {
		const params = { freq: 157.95, mode: 'nfm', enabled: true, [protocol]: true };
		const state = { squelchOpen: false, squelchDb: -120, audioQueue: new Float32Array(24000), audioQueueLen: 0, audioChannels: 1 };
		const backend = { vfoParams: [params], vfoStates: [state] };
		installWorkerAudioHandler(
			backend,
			0,
			{ audioSamplesOut: 0, dspTimeSum: 0, dspTimeMax: 0, audioCalls: 0 },
			null,
			() => {},
			{},
			() => {},
		);
		const legs = new PagerLegs(QuietProcessor, 48000, {
			inputIsFloat: () => true,
			floatPtr: () => 0,
			iqPtr: () => 0,
			wasmMemory: () => new ArrayBuffer(960 * 4),
			post: (msg) => backend._handleWorkerAudio(0, msg),
			onError: (msg) => {
				throw new Error(msg);
			},
		});
		legs.configure(params, 2000000, 0);
		for (const open of [true, false]) {
			backend._handleWorkerAudio(0, audio(open));
			backend._latchedSquelchOpen = [false];
			legs.process(960, 1);
			// A tagged signal flag must not drive main-channel latches either.
			backend._handleWorkerAudio(0, audio(true, protocol));
			expect({ open: state.squelchOpen, db: state.squelchDb }).toEqual({ open, db: open ? -50 : -120 });
			expect(backend._latchedSquelchOpen).toEqual([false]);
		}
	});
	it.each(['pocsag', 'gsc', 'flex'])('keeps remote main-channel squelch state independent of %s audio', async (protocol) => {
		vi.stubGlobal(
			'Worker',
			class {
				postMessage() {}
			},
		);
		const backend = { _sampleRate: 2000000, _centerFreq: 157.9, sharedIqPools: [] };
		for (const [name, method] of Object.entries(remoteBackend)) backend[name] = method.bind(backend);
		const squelch = vi.fn();
		backend.setRemoteHostSquelchCallback(squelch);
		await backend.addRemoteClient('pager-test');
		await backend.setRemoteVfoParams('pager-test', 0, { freq: 157.95, mode: 'nfm', enabled: true, [protocol]: true });
		const state = backend._remoteClients.get('pager-test');
		const send = (message) => state.workers[0].onmessage({ data: message });
		send(audio(true));
		expect(state.squelchOpen).toEqual([true]);
		expect(squelch).toHaveBeenCalledWith('pager-test', [true]);
		squelch.mockClear();
		send(audio(false, protocol));
		expect(state.squelchOpen).toEqual([true]);
		expect(squelch).not.toHaveBeenCalled();
		send(audio(false));
		expect(squelch).toHaveBeenCalledWith('pager-test', [false]);
	});
});
