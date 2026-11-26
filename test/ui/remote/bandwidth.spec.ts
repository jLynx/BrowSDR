import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { shallowReactive } from 'vue';
import { ReceiverView } from '../helpers/receiver-view';
import type { AppInstance } from '@/app/core/receiver.types';
import UiBandwidth, { formatBandwidth } from '@/ui/indicators/UiBandwidth';
import RemoteBandwidth from '@/app/workspace/remote-bandwidth';
import { emptyBandwidth, type BandwidthMonitor } from '@/remote/bandwidth';
import type { BandwidthSnapshot } from '@/remote/bandwidth.types';

let wrapper: VueWrapper;
afterEach(() => wrapper?.unmount());

function monitor() {
	const listeners = new Set<(value: BandwidthSnapshot) => void>();
	const unsubscribe = vi.fn();
	return {
		model: {
			subscribe(listener: (value: BandwidthSnapshot) => void) {
				listeners.add(listener);
				listener(emptyBandwidth());
				return () => {
					listeners.delete(listener);
					unsubscribe();
				};
			},
		} as unknown as BandwidthMonitor,
		unsubscribe,
		emit: (value: BandwidthSnapshot) => listeners.forEach((listener) => listener(value)),
	};
}

describe('sharing bandwidth UI', () => {
	it('formats network bits per second and shows the host total across clients/receivers', () => {
		expect(formatBandwidth(500000)).toBe('4.00 Mbps');
		expect(formatBandwidth(1250)).toBe('10.0 kbps');
		wrapper = mount(UiBandwidth, { props: { ready: true, host: true, peers: 5, uploadBps: 5000000, downloadBps: 1000 } });
		expect(wrapper.findAll('.form-row')[0].text()).toBe('Live upload40.00 Mbps');
		expect(wrapper.text()).toContain('5 clients · total across all SDRs');
	});
	it('prioritizes client download and distinguishes sampling/unavailable from zero traffic', async () => {
		wrapper = mount(UiBandwidth);
		expect(wrapper.findAll('.form-row')[0].text()).toBe('Live downloadMeasuring…');
		await wrapper.setProps({ ready: true, downloadBps: 0 });
		expect(wrapper.text()).toContain('0.0 kbps');
		await wrapper.setProps({ unavailable: true });
		expect(wrapper.text()).toContain('Unavailable');
		expect(wrapper.text()).not.toContain('0.0 kbps');
	});
	it('updates independently, unsubscribes when the shared connection changes, and cleans up on unmount', async () => {
		const old = monitor(),
			current = monitor();
		const receiver = shallowReactive({ remoteMode: 'host', _webrtc: { bandwidth: old.model } });
		wrapper = mount(RemoteBandwidth, { global: { provide: { receiver } } });
		old.emit({ ...emptyBandwidth(), ready: true, peers: 2, uploadBps: 1000000 });
		await wrapper.vm.$nextTick();
		expect(wrapper.text()).toContain('8.00 Mbps');
		receiver._webrtc = { bandwidth: current.model };
		await wrapper.vm.$nextTick();
		expect(old.unsubscribe).toHaveBeenCalledOnce();
		old.emit({ ...emptyBandwidth(), ready: true, uploadBps: 10000000 });
		expect(wrapper.text()).not.toContain('80.00 Mbps');
		current.emit({ ...emptyBandwidth(), ready: true, uploadBps: 250000, peers: 1 });
		await wrapper.vm.$nextTick();
		expect(wrapper.text()).toContain('2.00 Mbps');
		expect(wrapper.text()).toContain('1 client · total across all SDRs');
		wrapper.unmount();
		expect(current.unsubscribe).toHaveBeenCalledOnce();
	});
	it('binds the live monitor in the Source panel and unsubscribes when sharing stops', async () => {
		const live = monitor();
		wrapper = mount(ReceiverView);
		const receiver = wrapper.vm as unknown as AppInstance;
		receiver._webrtc = { bandwidth: live.model } as AppInstance['_webrtc'];
		await wrapper.setData({ remoteMode: 'host' });
		live.emit({ ...emptyBandwidth(), ready: true, peers: 3, uploadBps: 1000000 });
		await wrapper.vm.$nextTick();
		expect(wrapper.get('[aria-label="Live sharing bandwidth"]').text()).toContain('8.00 Mbps');
		expect(wrapper.text()).toContain('3 clients · total across all SDRs');
		await wrapper.setData({ remoteMode: 'none' });
		expect(wrapper.find('[aria-label="Live sharing bandwidth"]').exists()).toBe(false);
		expect(live.unsubscribe).toHaveBeenCalledOnce();
	});
});
