import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive, nextTick } from 'vue';
import DiscoveryPanel from '@/app/discovery/panel';
import { submitDiscovery } from '@/app/discovery/bridge';
import { createAppData } from '@/app/core/state';
import type { AppInstance } from '@/app/core/receiver.types';
import type { DiscoveryResult } from '@/worker/discovery/types';

afterEach(() => vi.unstubAllGlobals());
describe('signal discovery lifecycle', () => {
	it('bounds in-flight work, preserves the input and retains discovery when closed', async () => {
		class FakeWorker {
			onmessage?: (event: { data: DiscoveryResult }) => void;
			postMessage = vi.fn();
			terminate = vi.fn();
			constructor() {
				workers.push(this);
			}
		}
		const workers: FakeWorker[] = [];
		vi.stubGlobal('Worker', FakeWorker);
		const receiver = reactive({
			...createAppData(),
			connected: true,
			running: true,
			validateAndApplyVfoFreq: vi.fn(),
			isFreqInBandwidth: () => true,
			scrollSelectedVfoIntoView: vi.fn(),
			applyZoomToEngine: vi.fn(),
		}) as unknown as AppInstance;
		receiver.discovery.panelOpen = true;
		receiver.radio.centerFreq = 130;
		receiver.discovery.enabled = true;
		const wrapper = mount(DiscoveryPanel, { global: { provide: { receiver } } });
		const input = new Float32Array(65536).fill(-100);
		submitDiscovery(receiver, input);
		submitDiscovery(receiver, input);
		expect(workers[0].postMessage).toHaveBeenCalledTimes(1);
		expect(input.byteLength).toBe(65536 * 4);
		expect(workers[0].postMessage.mock.calls[0][0].data).not.toBe(input);
		workers[0].onmessage?.({
			data: {
				time: Date.now(),
				binHz: 305,
				frames: 1,
				signals: [
					{
						id: 1,
						frequencyHz: 129.125e6,
						widthHz: 12500,
						aboveNoiseDb: 20,
						firstSeen: Date.now(),
						lastSeen: Date.now(),
						hits: 1,
						observations: 1,
						active: true,
					},
				],
			},
		});
		await nextTick();
		await wrapper.get('tbody button').trigger('click');
		expect(receiver.view.zoomScale).toBe(32);
		expect(receiver.view.zoomOffset + 0.5 / receiver.view.zoomScale).toBeCloseTo(0.45625);
		expect(receiver.applyZoomToEngine).toHaveBeenCalled();
		expect(receiver.validateAndApplyVfoFreq).not.toHaveBeenCalled();
		expect(wrapper.text()).toContain('Detected now');
		workers[0].onmessage?.({
			data: {
				time: Date.now(),
				binHz: 305,
				frames: 2,
				signals: [
					{
						id: 1,
						frequencyHz: 129.125e6,
						widthHz: 12500,
						aboveNoiseDb: 20,
						firstSeen: Date.now(),
						lastSeen: Date.now(),
						hits: 1,
						observations: 2,
						active: false,
					},
				],
			},
		});
		await nextTick();
		expect(wrapper.text()).toContain('Previously detected · not detected now');
		expect(wrapper.get('tbody').text()).toContain('History');
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Tune selected VFO')!
			.trigger('click');
		expect(receiver.validateAndApplyVfoFreq).toHaveBeenCalledWith(0, 129.125);
		await wrapper.get('button[aria-label="Close Signal Discovery"]').trigger('click');
		expect(receiver.discovery.enabled).toBe(true);
		receiver.discovery.panelOpen = true;
		await nextTick();
		expect(wrapper.text()).toContain('129.125000');
		receiver.radio.centerFreq = 140;
		await nextTick();
		expect(wrapper.find('tbody').exists()).toBe(false);
		expect(workers[0].terminate).toHaveBeenCalled();
		wrapper.unmount();
	});
});
