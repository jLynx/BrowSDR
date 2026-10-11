import { expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive } from 'vue';
import GainReset, { restoreDeviceGains } from '@/app/radio/gain-settings';
import { HackRFDevice } from '@/devices/hackrf/device';

it('restores valid saved device gains and rejects invalid steps', () => {
	const caps = new HackRFDevice();
	expect(restoreDeviceGains(caps, { LNA: 32, VGA: 22, 'Amp (14dB)': 1 })).toEqual({ LNA: 32, VGA: 22, 'Amp (14dB)': 1 });
	expect(restoreDeviceGains(caps, { LNA: 23, VGA: 99 })).toEqual({ LNA: 16, VGA: 16, 'Amp (14dB)': 0 });
});

it('shows reset only for changed gains and hides it after resetting', async () => {
	const receiver = reactive({
		deviceCapabilities: new HackRFDevice(),
		gains: { LNA: 32, VGA: 22, 'Amp (14dB)': 1 },
		autoGain: { active: false },
		remoteMode: 'none',
	});
	const wrapper = mount(GainReset, { global: { provide: { receiver } } });
	expect(wrapper.get('button').attributes('aria-label')).toBe('Reset gains');
	await wrapper.get('button').trigger('click');
	expect(receiver.gains).toEqual({ LNA: 16, VGA: 16, 'Amp (14dB)': 0 });
	expect(wrapper.find('button').exists()).toBe(false);
	wrapper.unmount();
});
