import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive, markRaw } from 'vue';
import { File as NodeFile } from 'node:buffer';
import Loader from '@/app/replay/loader';
import Panel from '@/app/replay/panel';
import { replayMethods, restoreReplaySettings } from '@/app/replay/connection';
import { createAppData } from '@/app/core/state';
import { settingsMethods } from '@/app/radio/settings';
import { ReceiverView } from '../helpers/receiver-view';
import type { AppInstance } from '@/app/core/receiver.types';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function files() {
	const data = new NodeFile([new Uint8Array(4000)], 'test.sigmf-data') as unknown as File;
	const meta = new NodeFile(
		[
			JSON.stringify({
				global: { 'core:datatype': 'ci8', 'core:sample_rate': 20000000 },
				captures: [{ 'core:sample_start': 0, 'core:frequency': 923118000 }],
			}),
		],
		'test.sigmf-meta.json',
	) as unknown as File;
	return { data, meta };
}

describe('IQ replay UI', () => {
	it('offers file replay in production even without WebUSB', async () => {
		vi.stubEnv('DEV', false);
		vi.stubGlobal('navigator', { onLine: true });
		const wrapper = mount(ReceiverView);
		await wrapper.vm.connect();
		const button = wrapper.findAll('button').find((item) => item.text().includes('IQ File Replay'))!;
		await button.trigger('click');
		expect(wrapper.vm.showIqReplayLoader).toBe(true);
		expect(wrapper.get('[aria-label="IQ recording files"]').exists()).toBe(true);
		wrapper.unmount();
	});
	it('loads matching data and metadata without reading the IQ file into memory', async () => {
		const receiver = reactive({ ...createAppData(), showIqReplayLoader: true, connectIqReplay: vi.fn(async () => {}) });
		const wrapper = mount(Loader, { global: { provide: { receiver } } });
		const { data, meta } = files();
		const read = vi.spyOn(data, 'arrayBuffer');
		const input = wrapper.get('input[type=file]');
		Object.defineProperty(input.element, 'files', { value: [data, meta], configurable: true });
		await input.trigger('change');
		await flushPromises();
		expect(wrapper.get('[aria-label="Recorded sample rate"]').attributes('disabled')).toBeDefined();
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Load recording')!
			.trigger('click');
		expect(receiver.connectIqReplay).toHaveBeenCalledWith(
			expect.objectContaining({ file: data, sampleRate: 20000000, centerHz: 923118000 }),
		);
		expect(read).not.toHaveBeenCalled();
		wrapper.unmount();
	});
	it('rejects mismatched filenames before creating a receiver', async () => {
		const receiver = reactive({ ...createAppData(), showIqReplayLoader: true });
		const wrapper = mount(Loader, { global: { provide: { receiver } } });
		const { data } = files();
		const meta = new NodeFile(['{}'], 'other.sigmf-meta.json');
		const input = wrapper.get('input[type=file]');
		Object.defineProperty(input.element, 'files', { value: [data, meta] });
		await input.trigger('change');
		expect(wrapper.get('[role=alert]').text()).toContain('filenames must match');
		wrapper.unmount();
	});
	it('keeps hardware settings intact and loads paused with no gain controls', async () => {
		const recording = { file: files().data, sampleRate: 20000000, centerHz: 923118000, frequencyShiftHz: 0 };
		const receiver = reactive({
			...createAppData(),
			_initAudioCtx: vi.fn(),
			formatFreq: (freq: number) => freq.toFixed(6),
			showMsg: vi.fn(),
			backend: {
				openIqReplay: vi.fn(async () => {}),
				getDeviceCapabilities: vi.fn(async () => ({
					deviceType: 'iq-replay',
					sampleRates: [20000000],
					gainControls: [],
					sampleFormat: 'int8',
				})),
				info: vi.fn(async () => ({ name: 'IQ File Replay' })),
				close: vi.fn(async () => {}),
			},
		}) as unknown as AppInstance;
		const original = { ...receiver.radio };
		await replayMethods._connectIqReplay.call(receiver, recording);
		expect(receiver.radio.centerFreq).toBe(923.118);
		expect(receiver.running).toBe(false);
		expect(receiver.gains).toEqual({});
		const save = vi.spyOn(Storage.prototype, 'setItem');
		settingsMethods.saveSetting.call(receiver);
		expect(save).not.toHaveBeenCalled();
		restoreReplaySettings(receiver);
		expect(receiver.radio).toEqual(original);
		expect(receiver.vfos[0].freq).toBe(100);
	});
	it('waits for DSP draining before stopping at EOF and cancels polling on unmount', async () => {
		vi.useFakeTimers();
		const recording = markRaw({ file: files().data, sampleRate: 20000000, centerHz: 923118000, frequencyShiftHz: 0 });
		const receiver = reactive({
			...createAppData(),
			connected: true,
			running: true,
			iqReplay: { recording, progress: { state: 'playing', seconds: 0, duration: 60, delaySeconds: 0 } },
			togglePlay: vi.fn(async () => {}),
			backend: { getIqReplayProgress: vi.fn(async () => ({ state: 'draining', seconds: 60, duration: 60, delaySeconds: 0 })) },
		});
		const wrapper = mount(Panel, { global: { provide: { receiver } } });
		await vi.advanceTimersByTimeAsync(250);
		expect(receiver.togglePlay).not.toHaveBeenCalled();
		receiver.backend.getIqReplayProgress.mockResolvedValue({ state: 'ended', seconds: 60, duration: 60, delaySeconds: 0 });
		await vi.advanceTimersByTimeAsync(250);
		expect(receiver.togglePlay).toHaveBeenCalledOnce();
		wrapper.unmount();
		const calls = receiver.backend.getIqReplayProgress.mock.calls.length;
		await vi.advanceTimersByTimeAsync(1000);
		expect(receiver.backend.getIqReplayProgress.mock.calls).toHaveLength(calls);
	});
});
