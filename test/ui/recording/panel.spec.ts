import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';
import IqCapturePanel from '@/app/recording/panel';
import { createAppData } from '@/app/core/state';
import type { AppInstance } from '@/app/core/receiver.types';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function panel() {
	const backend = {
		captureIq: vi.fn(async () => ({ data: new Int8Array([1, -1]), missingSamples: null })),
		captureIqToFile: vi.fn(async () => ({ byteLength: 3600000000, missingSamples: 0 })),
		getIqCaptureProgress: vi.fn(async () => ({ capturedBytes: 4000000, writtenBytes: 2000000, totalBytes: 3600000000 })),
		cancelIqCapture: vi.fn(async () => {}),
	};
	const receiver = reactive({ ...createAppData(), running: true, backend }) as unknown as AppInstance;
	receiver.radio.sampleRate = 2e6;
	receiver.iqRecording.panelOpen = true;
	const wrapper = mount(IqCapturePanel, { global: { provide: { receiver } } });
	const button = () => wrapper.findAll('button').find((value) => value.text() === 'Capture IQ')!;
	return { receiver, backend, wrapper, button };
}

describe('IQ capture panel', () => {
	it('starts a 15-minute file capture and offers its matching metadata', async () => {
		const file = { name: 'flex-traffic.sigmf-data' };
		const picker = vi.fn(async () => file);
		vi.stubGlobal('showSaveFilePicker', picker);
		const { wrapper, backend, button } = panel();
		await wrapper.get('input').setValue(15);
		await wrapper.get('select').setValue('60');
		expect(wrapper.text()).toContain('3.35 GiB');
		expect(button().attributes('disabled')).toBeUndefined();
		await button().trigger('click');
		await flushPromises();
		expect(picker).toHaveBeenCalledOnce();
		expect(picker).toHaveBeenCalledWith({ suggestedName: expect.stringMatching(/\.sigmf-data$/) });
		expect(backend.captureIqToFile).toHaveBeenCalledWith(900, file);
		expect(backend.captureIq).not.toHaveBeenCalled();
		expect(wrapper.text()).toContain('IQ file saved');
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
		expect(wrapper.get('[role="status"]').text()).toContain('64 MiB memory limit');
		expect(wrapper.get('[role="status"]').text()).toContain('Chrome or Edge');
		expect(backend.captureIq).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	it('keeps small captures available for download without a file picker', async () => {
		vi.stubGlobal('showSaveFilePicker', undefined);
		const { wrapper, button, backend } = panel();
		await button().trigger('click');
		await flushPromises();
		expect(backend.captureIq).toHaveBeenCalledWith(5);
		expect(wrapper.text()).toContain('Download IQ');
		expect(wrapper.text()).toContain('Download metadata');
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
		wrapper.unmount();
		expect(backend.cancelIqCapture).toHaveBeenCalledOnce();
		finish({ byteLength: 3600000000, missingSamples: 0 });
		await flushPromises();
	});
});
