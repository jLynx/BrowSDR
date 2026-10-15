import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { ReceiverView } from '../helpers/receiver-view';

let wrapper: VueWrapper;
afterEach(() => {
	wrapper?.vm._disposeAudioRecording();
	wrapper?.unmount();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function setupDownloads() {
	const create = vi.fn(() => 'blob:recording');
	const revoke = vi.fn();
	vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
	const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
	return { create, revoke, click };
}

async function receiving() {
	await wrapper.setData({ connected: true, running: true });
	wrapper.vm.vfos[0].enabled = true;
	wrapper.vm.audioCtx = { state: 'running' };
	wrapper.vm._audioWorklet = {
		port: {
			postMessage: vi.fn((message: { samples?: Float32Array }) => {
				if (message.samples) structuredClone(message.samples, { transfer: [message.samples.buffer] });
			}),
		},
	};
}

describe('receiver audio recording', () => {
	it('starts from the header, saves captured PCM, previews it, and downloads it again', async () => {
		const { create, click } = setupDownloads();
		wrapper = mount(ReceiverView);
		expect(wrapper.get('[aria-label="Record audio"]').attributes('disabled')).toBeDefined();
		await receiving();
		wrapper.vm.vfos[0].freq = 45.825;
		wrapper.vm.vfos[0].mode = 'nfm';
		await wrapper.get('[aria-label="Record audio"]').trigger('click');
		expect(wrapper.vm.audioRecording.active).toBe(true);
		const samples = new Float32Array(48000).fill(0.25);
		wrapper.vm.playAudio(samples);
		expect(samples.byteLength).toBe(0);
		await nextTick();
		expect(wrapper.get('[role="status"]').text()).toContain('REC');
		await wrapper.get('[aria-label="Stop and save audio recording"]').trigger('click');
		expect(wrapper.vm.audioRecording.active).toBe(false);
		expect(wrapper.vm.audioRecording.seconds).toBe(1);
		expect(wrapper.vm.audioRecording.filename).toMatch(/^BrowSDR-45\.825000MHz-nfm-.*\.wav$/);
		expect(create).toHaveBeenCalledOnce();
		expect(create.mock.calls[0][0]).toMatchObject({ size: 192044, type: 'audio/wav' });
		expect(click).toHaveBeenCalledOnce();
		expect(wrapper.get('audio[controls]').attributes('src')).toBe('blob:recording');
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Download latest WAV')!
			.trigger('click');
		expect(click).toHaveBeenCalledTimes(2);
	});
	it('saves when reception stops and frees the previous preview on replacement and disposal', async () => {
		const { revoke, click } = setupDownloads();
		wrapper = mount(ReceiverView);
		await receiving();
		wrapper.vm.toggleAudioRecording();
		wrapper.vm.playAudio(new Float32Array(100));
		wrapper.vm.backend = { stopRx: vi.fn().mockResolvedValue(undefined) };
		wrapper.vm._disposeAudioWorklet = vi.fn();
		wrapper.vm.audioCtx.close = vi.fn().mockResolvedValue(undefined);
		await wrapper.vm._togglePlay();
		expect(wrapper.vm.audioRecording.active).toBe(false);
		expect(click).toHaveBeenCalledOnce();
		await receiving();
		wrapper.vm.toggleAudioRecording();
		wrapper.vm.playAudio(new Float32Array(100));
		wrapper.vm.stopAudioRecording();
		expect(revoke).toHaveBeenCalledOnce();
		wrapper.vm._disposeAudioRecording();
		expect(revoke).toHaveBeenCalledTimes(2);
		expect(wrapper.vm.audioRecording.url).toBe('');
	});
	it('rejects muted reception and avoids creating an empty download', async () => {
		const { create } = setupDownloads();
		wrapper = mount(ReceiverView);
		await receiving();
		wrapper.vm.vfos[0].enabled = false;
		wrapper.vm.toggleAudioRecording();
		expect(wrapper.vm.audioRecording.active).toBe(false);
		wrapper.vm.vfos[0].enabled = true;
		wrapper.vm.toggleAudioRecording();
		wrapper.vm.stopAudioRecording();
		expect(create).not.toHaveBeenCalled();
		expect(wrapper.vm.snackbar.message).toContain('No audio samples');
	});
});
