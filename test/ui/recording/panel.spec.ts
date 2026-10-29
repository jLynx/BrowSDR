import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';
import IqCapturePanel from '@/app/recording/panel';
import { createAppData } from '@/app/core/state';
import type { AppInstance } from '@/app/core/receiver.types';
import type { IqCaptureProgress } from '@/worker/recording/types';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function panel() {
	const backend = {
		captureIq: vi.fn(async () => ({ data: new Int8Array([1, -1]), missingSamples: null })),
		captureIqToFile: vi.fn(async () => ({ byteLength: 3600000000, missingSamples: 0 })),
		getIqCaptureProgress: vi.fn(async (): Promise<IqCaptureProgress> => ({
			capturedBytes: 4000000,
			writtenBytes: 2000000,
			totalBytes: 3600000000,
		})),
		cancelIqCapture: vi.fn(async () => {}),
		stopIqCapture: vi.fn(async () => {}),
	};
	const receiver = reactive({ ...createAppData(), running: true, backend }) as unknown as AppInstance;
	receiver.radio.sampleRate = 2e6;
	receiver.iqRecording.panelOpen = true;
	const wrapper = mount(IqCapturePanel, { global: { provide: { receiver } } });
	const button = () => wrapper.findAll('button').find((value) => value.text() === 'Start recording')!;
	return { receiver, backend, wrapper, button };
}

describe('IQ capture panel', () => {
	it('explains browser finalization and keeps metadata available after a failed file commit', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('showSaveFilePicker', async () => ({ name: 'capture.sigmf-data' }));
		const { wrapper, backend, button } = panel();
		let rejectCapture!: (error: Error) => void;
		backend.captureIqToFile.mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					rejectCapture = reject;
				}),
		);
		backend.getIqCaptureProgress.mockResolvedValue({
			capturedBytes: 3600000000,
			writtenBytes: 3600000000,
			totalBytes: 3600000000,
			phase: 'finalizing',
		});
		await wrapper.get('input').setValue(900);
		await button().trigger('click');
		await flushPromises();
		await vi.advanceTimersByTimeAsync(1000);
		expect(wrapper.get('[role="status"]').text()).toContain('Finalizing 3.35 GiB');
		expect(wrapper.get('[role="status"]').text()).toContain('several minutes');
		const error = new Error('The browser could not finalize capture.sigmf-data. Preserve the .crswap file for recovery.');
		error.name = 'IqFileFinalizeError';
		rejectCapture(error);
		await flushPromises();
		expect(wrapper.get('[role="status"]').text()).toContain('.crswap');
		expect(wrapper.text()).toContain('Download metadata');
		expect(wrapper.text()).not.toContain('Download IQ data');
		const metadata = JSON.parse((wrapper.vm as unknown as { metadata: string }).metadata);
		expect(metadata.global['core:sample_rate']).toBe(2e6);
		expect(metadata.global['browsdr:missing_samples']).toBeNull();
		wrapper.unmount();
	});

	it('starts manual capture without a picker and saves the samples when stopped', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('showSaveFilePicker', undefined);
		const { wrapper, backend, button } = panel();
		let finish!: (value: { data: Int8Array<ArrayBuffer>; missingSamples: null }) => void;
		backend.captureIq.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		backend.stopIqCapture.mockImplementationOnce(async () => {
			finish({ data: new Int8Array([1, -1]), missingSamples: null });
		});
		await wrapper.get('[aria-label="Recording mode"]').setValue('manual');
		expect(wrapper.find('input').exists()).toBe(false);
		expect(wrapper.text()).toContain('64 MiB download limit');
		await button().trigger('click');
		await flushPromises();
		expect(backend.captureIq).toHaveBeenCalledWith(null);
		await vi.advanceTimersByTimeAsync(1000);
		expect(wrapper.get('[role="status"]').text()).toContain('1.0 s');
		expect(wrapper.get('[role="status"]').text()).not.toContain(' / ');
		expect(wrapper.get('progress').attributes('value')).toBeUndefined();
		await wrapper
			.findAll('button')
			.find((value) => value.text() === 'Stop recording')!
			.trigger('click');
		await flushPromises();
		expect(backend.stopIqCapture).toHaveBeenCalledOnce();
		expect(backend.cancelIqCapture).not.toHaveBeenCalled();
		expect(wrapper.text()).toContain('Download IQ data');
		expect(wrapper.text()).toContain('Download metadata');
		wrapper.unmount();
	});

	it('uses direct file saving for manual recording and disables stop while choosing a file', async () => {
		let choose!: (file: { name: string }) => void;
		vi.stubGlobal(
			'showSaveFilePicker',
			() =>
				new Promise((resolve) => {
					choose = resolve;
				}),
		);
		const { wrapper, backend, button } = panel();
		await wrapper.get('[aria-label="Recording mode"]').setValue('manual');
		await button().trigger('click');
		expect(
			wrapper
				.findAll('button')
				.find((value) => value.text() === 'Stop recording')!
				.attributes('disabled'),
		).toBeDefined();
		const file = { name: 'manual.sigmf-data' };
		choose(file);
		await flushPromises();
		expect(backend.captureIqToFile).toHaveBeenCalledWith(null, file);
		expect(wrapper.text()).toContain('Download metadata');
		wrapper.unmount();
	});

	it('uses the shared header and inputs and explains general signal analysis', () => {
		const { wrapper } = panel();
		expect(wrapper.get('.msgcenter-header .msgcenter-title').text()).toContain('IQ Recorder');
		expect(wrapper.find('.pocsag-header').exists()).toBe(false);
		expect(wrapper.get('.input-group input').attributes('aria-label')).toBe('Recording duration');
		expect(wrapper.get('label').attributes('for')).toBe(wrapper.get('[aria-label="Recording mode"]').attributes('id'));
		expect(wrapper.text()).toContain('analyse later');
		expect(wrapper.text()).not.toContain('decoder development');
		wrapper.unmount();
	});

	it('starts a 15-minute file capture and offers its matching metadata', async () => {
		const file = { name: 'flex-traffic.sigmf-data' };
		const picker = vi.fn(async () => file);
		vi.stubGlobal('showSaveFilePicker', picker);
		const { wrapper, backend, button } = panel();
		await wrapper.get('input').setValue(15);
		await wrapper.get('[aria-label="Duration unit"]').setValue('60');
		expect(wrapper.text()).toContain('3.35 GiB');
		expect(button().attributes('disabled')).toBeUndefined();
		await button().trigger('click');
		await flushPromises();
		expect(picker).toHaveBeenCalledOnce();
		expect(picker).toHaveBeenCalledWith({ suggestedName: expect.stringMatching(/\.sigmf-data$/) });
		expect(backend.captureIqToFile).toHaveBeenCalledWith(900, file);
		expect(backend.captureIq).not.toHaveBeenCalled();
		expect(wrapper.text()).toContain('IQ data saved');
		expect(wrapper.text()).toContain('Download metadata');
		expect(wrapper.text()).not.toContain('Download IQ');
		const metadata = JSON.parse((wrapper.vm as unknown as { metadata: string }).metadata);
		expect(metadata.global['core:datatype']).toBe('ci8');
		expect(metadata.global['core:sample_rate']).toBe(2e6);
		expect(metadata.global['browsdr:missing_samples']).toBe(0);
		wrapper.unmount();
	});

	it('explains the size limit when direct file saving is unavailable', async () => {
		vi.stubGlobal('showSaveFilePicker', undefined);
		const { wrapper, button, backend } = panel();
		await wrapper.get('input').setValue(240);
		expect(button().attributes('disabled')).toBeDefined();
		expect(wrapper.get('[role="status"]').text()).toContain('64 MiB download limit');
		expect(wrapper.get('[role="status"]').text()).toContain('Chrome or Edge');
		expect(backend.captureIq).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	it('keeps small captures available for download without a file picker', async () => {
		vi.stubGlobal('showSaveFilePicker', undefined);
		const { wrapper, button, backend, receiver } = panel();
		await button().trigger('click');
		await flushPromises();
		expect(backend.captureIq).toHaveBeenCalledWith(5);
		expect(wrapper.text()).toContain('Download IQ');
		expect(wrapper.text()).toContain('Download metadata');
		receiver.running = false;
		await flushPromises();
		expect(wrapper.get('[role="status"]').text()).toContain('Your recording is ready to download');
		expect(button().attributes('disabled')).toBeDefined();
		wrapper.unmount();
	});

	it('does not start recording when the save dialog is cancelled or reception stops during selection', async () => {
		const picker = vi.fn().mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
		vi.stubGlobal('showSaveFilePicker', picker);
		const { wrapper, receiver, button, backend } = panel();
		await wrapper.get('input').setValue(900);
		await button().trigger('click');
		await flushPromises();
		expect(wrapper.get('[role="status"]').text()).toBe('File selection cancelled.');
		picker.mockImplementationOnce(async () => {
			receiver.running = false;
			return { name: 'test.sigmf-data' };
		});
		await button().trigger('click');
		await flushPromises();
		expect(backend.captureIqToFile).not.toHaveBeenCalled();
		expect(button().attributes('disabled')).toBeDefined();
		wrapper.unmount();
	});

	it('reports file progress and cancels an active capture on unmount', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('showSaveFilePicker', async () => ({ name: 'test.sigmf-data' }));
		const { wrapper, button, backend } = panel();
		let finish!: (value: { byteLength: number; missingSamples: number }) => void;
		backend.captureIqToFile.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await wrapper.get('input').setValue(900);
		await button().trigger('click');
		await flushPromises();
		await vi.advanceTimersByTimeAsync(1000);
		expect(wrapper.get('[role="status"]').text()).toContain('1.0 / 900.0 s');
		expect(wrapper.get('progress').attributes('aria-label')).toBe('Recording progress');
		expect(wrapper.get('input').attributes('disabled')).toBeDefined();
		expect(wrapper.get('select').attributes('disabled')).toBeDefined();
		expect(wrapper.findAll('button').some((value) => value.text().startsWith('Download'))).toBe(false);
		wrapper.unmount();
		expect(backend.cancelIqCapture).toHaveBeenCalledOnce();
		finish({ byteLength: 3600000000, missingSamples: 0 });
		await flushPromises();
	});
});
