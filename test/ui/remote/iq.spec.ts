import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { ReceiverView } from '../helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';
import type { AppInstance } from '@/app/core/receiver.types';

let wrapper: VueWrapper;
afterEach(() => {
	wrapper?.unmount();
	vi.restoreAllMocks();
});

async function receiver() {
	wrapper = mount(ReceiverView);
	const backend = { setRemoteIqEnabled: vi.fn(), setRemoteIqVfoParams: vi.fn(), addVfo: vi.fn(), removeVfo: vi.fn() };
	const transport = { sendCommand: vi.fn() };
	await wrapper.setData({
		remoteMode: 'client',
		running: true,
		connected: true,
		backend,
		_webrtc: transport,
		radio: { centerFreq: 100, sampleRate: 20e6, fftSize: 65536 },
		vfos: [{ ...makeDefaultVfo(106.2), enabled: true }],
	});
	const app = wrapper.vm as unknown as AppInstance;
	vi.spyOn(app, '_resetAudioPlayback').mockImplementation(() => {});
	return { app, backend, transport };
}

describe('remote decoding controls', () => {
	it('negotiates fixed IQ8 without changing capture precision, and switches back to host audio', async () => {
		const { app, backend, transport } = await receiver();
		await wrapper.setData({ gains: { 'IQ Precision': 1 } });
		expect(wrapper.find('#test-receiver-remote-decoding').exists()).toBe(false);
		app.handleRemoteCommand({ type: 'streamCapabilities', iqSlices: true });
		await flushPromises();
		expect(app.remoteIqActive).toBe(true);
		expect(wrapper.text()).toContain('8-bit IQ payload: approximately 4.00 Mbps');
		expect(transport.sendCommand).toHaveBeenCalledWith({ type: 'clientStream', stream: 'iq', bits: 8 });
		expect(wrapper.find('#test-receiver-remote-iq-bits').exists()).toBe(false);
		expect(app.gains['IQ Precision']).toBe(1);
		await wrapper.get('#test-receiver-remote-decoding').setValue('host');
		await flushPromises();
		expect(app.remoteIqActive).toBe(false);
		expect(backend.setRemoteIqEnabled).toHaveBeenLastCalledWith(false);
		expect(transport.sendCommand).toHaveBeenCalledWith({ type: 'clientStream', stream: 'audio', bits: 8 });
		expect(app.gains['IQ Precision']).toBe(1);
		expect(wrapper.find('#test-receiver-remote-iq-bits').exists()).toBe(false);
		expect(wrapper.text()).toContain('Audio and decoded messages from the host');
	});
	it('preserves the RF revision for volume/squelch, changes it on retune, and allocates client VFOs', async () => {
		const { app, backend, transport } = await receiver();
		app.handleRemoteCommand({ type: 'streamCapabilities', iqSlices: true });
		await flushPromises();
		const revision = app.remoteIqRevisions[0];
		app.vfos[0].volume = 20;
		app.vfos[0].squelchLevel = -60;
		app.updateBackendVfoParams(0);
		expect(app.remoteIqRevisions[0]).toBe(revision);
		app.vfos[0].freq = 106.3;
		app.updateBackendVfoParams(0);
		expect(app.remoteIqRevisions[0]).toBeGreaterThan(revision);
		await app.addVfo();
		expect(backend.addVfo).toHaveBeenCalledOnce();
		expect(transport.sendCommand).toHaveBeenCalledWith({ type: 'addRemoteVfo' });
		expect(backend.setRemoteIqVfoParams).toHaveBeenCalledWith(1, expect.objectContaining({ freq: 100 }), expect.any(Number));
		await app.removeVfo(0);
		expect(backend.removeVfo).toHaveBeenCalledWith(0);
		expect(app.vfos).toHaveLength(1);
		expect(app.remoteIqRevisions[0]).toBeGreaterThan(revision);
	});
});
