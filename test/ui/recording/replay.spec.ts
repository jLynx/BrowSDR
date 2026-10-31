import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { RecordingFormat } from '@/radio/iq/types';
import { recordingBytesPerSample } from '@/radio/iq/format';

beforeEach(() => vi.stubEnv('DEV', true));

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

const formats: RecordingFormat[] = ['ci8', 'ci16_le', 'cf32_le'];

function files(format: RecordingFormat = 'ci8', sampleRate = 20000000, samples = 2000) {
	const data = new NodeFile([new Uint8Array(samples * recordingBytesPerSample(format))], 'test.sigmf-data') as unknown as File;
	const meta = new NodeFile(
		[
			JSON.stringify({
				global: { 'core:datatype': format, 'core:sample_rate': sampleRate },
				captures: [{ 'core:sample_start': 0, 'core:frequency': 923118000 }],
			}),
		],
		'test.sigmf-meta.json',
	) as unknown as File;
	return { data, meta };
}

describe('IQ replay UI', () => {
	it.each(formats)('previews a one-second %s recording with its actual sample width', async (format) => {
		const receiver = reactive({ ...createAppData(), showIqReplayLoader: true });
		const wrapper = mount(Loader, { global: { provide: { receiver } } });
		const { data, meta } = files(format, 1000, 1000);
		const input = wrapper.get('input[type=file]');
		Object.defineProperty(input.element, 'files', { value: [data, meta] });
		await input.trigger('change');
		await flushPromises();
		expect(wrapper.get('.iq-replay-file-summary small').text()).toBe('1.0 s');
		wrapper.unmount();
	});
	it('updates raw 8-bit preview duration when its manually entered sample rate changes', async () => {
		const receiver = reactive({ ...createAppData(), showIqReplayLoader: true });
		const wrapper = mount(Loader, { global: { provide: { receiver } } });
		const { data } = files('ci8', 1000, 1000);
		const input = wrapper.get('input[type=file]');
		Object.defineProperty(input.element, 'files', { value: [data] });
		await input.trigger('change');
		await wrapper.get('[aria-label="Recorded sample rate"]').setValue(0.001);
		expect(wrapper.get('.iq-replay-file-summary small').text()).toBe('1.0 s');
		await wrapper.get('[aria-label="Recorded sample rate"]').setValue(0.002);
		expect(wrapper.get('.iq-replay-file-summary small').text()).toBe('0.5 s');
		wrapper.unmount();
	});
	it('hides replay and prevents replay connections in production', async () => {
		vi.stubEnv('DEV', false);
		vi.stubGlobal('navigator', { onLine: true });
		const wrapper = mount(ReceiverView);
		await wrapper.vm.connect();
		expect(wrapper.findAll('button').some((item) => item.text().includes('IQ File Replay'))).toBe(false);
		await wrapper.setData({ showIqReplayLoader: true, backend: { openIqReplay: vi.fn(), replaceIqReplay: vi.fn() } });
		expect(wrapper.find('[aria-label="IQ recording files"]').exists()).toBe(false);
		const recording = { file: files().data, sampleRate: 20000000, centerHz: 923118000, frequencyShiftHz: 0 };
		await wrapper.vm.connectIqReplay(recording);
		await wrapper.vm._connectIqReplay(recording);
		await wrapper.vm.replaceIqReplay(recording);
		expect(wrapper.vm.backend.openIqReplay).not.toHaveBeenCalled();
		expect(wrapper.vm.backend.replaceIqReplay).not.toHaveBeenCalled();
		wrapper.unmount();
	});
	it('keeps IQ replay available in development when WebUSB is unavailable', async () => {
		vi.stubGlobal('navigator', { onLine: true });
		const wrapper = mount(ReceiverView);
		await wrapper.vm.connect();
		await wrapper
			.findAll('button')
			.find((button) => button.text().includes('IQ File Replay'))!
			.trigger('click');
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
	it.each(formats)('keeps hardware settings intact and initializes a one-second %s replay paused', async (format) => {
		const recording = { file: files(format, 1000, 1000).data, format, sampleRate: 1000, centerHz: 923118000, frequencyShiftHz: 0 };
		let finishOpen!: () => void;
		const receiver = reactive({
			...createAppData(),
			_initAudioCtx: vi.fn(),
			formatFreq: (freq: number) => freq.toFixed(6),
			showMsg: vi.fn(),
			backend: {
				openIqReplay: vi.fn(
					() =>
						new Promise<void>((resolve) => {
							finishOpen = resolve;
						}),
				),
				getDeviceCapabilities: vi.fn(async () => ({
					deviceType: 'iq-replay',
					sampleRates: [1000],
					gainControls: [],
					sampleFormat: format === 'ci8' ? 'int8' : format === 'ci16_le' ? 'int16' : 'float32',
				})),
				info: vi.fn(async () => ({ name: 'IQ File Replay' })),
				close: vi.fn(async () => {}),
			},
		}) as unknown as AppInstance;
		const original = { ...receiver.radio };
		const opening = replayMethods._connectIqReplay.call(receiver, recording);
		expect(receiver.iqReplay?.progress.duration).toBe(1);
		finishOpen();
		await opening;
		expect(receiver.iqReplay?.progress.duration).toBe(1);
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
	it.each(formats)('replaces a playing file with %s, keeping VFO settings and the hardware snapshot', async (format) => {
		const startup = createAppData();
		const current = { file: files().data, sampleRate: 20000000, centerHz: 923118000, frequencyShiftHz: 0 };
		const replacement = {
			...current,
			file: new NodeFile([new Uint8Array(4000 * recordingBytesPerSample(format))], 'replacement.iq') as unknown as File,
			format,
			sampleRate: 2000000,
			centerHz: 100000000,
		};
		const previous = {
			radio: { ...startup.radio },
			gains: { LNA: 16 },
			gainDeviceType: 'hackrf',
			vfos: startup.vfos.map((vfo) => ({ ...vfo })),
			view: { ...startup.view },
		};
		const receiver = reactive({
			...startup,
			connected: true,
			running: true,
			showIqReplayLoader: true,
			iqReplayReplace: true,
			iqReplay: { recording: markRaw(current), progress: { state: 'playing', seconds: 12, duration: 60, delaySeconds: 0 } },
			_replayPrevious: previous,
			_togglePlay: vi.fn(async () => {}),
			showMsg: vi.fn(),
			backend: {
				replaceIqReplay: vi.fn(async () => {}),
				getDeviceCapabilities: vi.fn(async () => ({
					deviceType: 'iq-replay',
					sampleRates: [2000000],
					gainControls: [],
					sampleFormat: 'int8',
				})),
				info: vi.fn(async () => ({ name: 'IQ File Replay', product: 'replacement.iq' })),
			},
		}) as unknown as AppInstance;
		(receiver._togglePlay as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			receiver.running = false;
		});
		receiver.vfos[0].freq = 921.791;
		receiver.vfos[0].rtk = true;
		receiver.vfos[0].rtkProfile = 'rtk2';
		receiver.vfos[0].rtkFollowHops = true;
		receiver.rtk.frames = [[]];
		const snapshot = receiver._replayPrevious;
		await replayMethods.replaceIqReplay.call(receiver, replacement);
		expect(receiver._togglePlay).toHaveBeenCalledOnce();
		expect(receiver.backend.replaceIqReplay).toHaveBeenCalledWith(replacement);
		expect(receiver.connected).toBe(true);
		expect(receiver.running).toBe(false);
		expect(receiver.iqReplay?.progress).toMatchObject({ state: 'ready', seconds: 0, duration: 0.002 });
		expect(receiver.vfos[0]).toMatchObject({ freq: 921.791, rtk: true, rtkProfile: 'rtk2', rtkFollowHops: true });
		expect(receiver.rtk.frames).toEqual([]);
		expect(receiver.radio).toMatchObject({ centerFreq: 100, sampleRate: 2000000 });
		expect(receiver._replayPrevious).toBe(snapshot);
		expect(receiver.showIqReplayLoader).toBe(false);
		expect(receiver._playChanging).toBe(false);
		restoreReplaySettings(receiver);
		expect(receiver.gains).toEqual({ LNA: 16 });
		expect(receiver.vfos[0].freq).toBe(100);
	});
	it('opens replacement in the existing panel and cancelling keeps the current recording', async () => {
		const receiver = reactive({
			...createAppData(),
			connected: true,
			iqReplay: {
				recording: markRaw({ file: files().data, sampleRate: 20000000, centerHz: 923118000, frequencyShiftHz: 0 }),
				progress: { state: 'paused', seconds: 12, duration: 60, delaySeconds: 0 },
			},
		});
		const panel = mount(Panel, { global: { provide: { receiver } } });
		const loader = mount(Loader, { global: { provide: { receiver } } });
		await panel
			.findAll('button')
			.find((button) => button.text() === 'Change recording')!
			.trigger('click');
		expect(loader.get('[role=dialog]').attributes('aria-label')).toBe('Change IQ recording');
		await loader
			.findAll('button')
			.find((button) => button.text() === 'Cancel')!
			.trigger('click');
		expect(receiver.iqReplay.progress.seconds).toBe(12);
		expect(receiver.iqReplay.recording.file.name).toBe('test.sigmf-data');
		panel.unmount();
		loader.unmount();
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
