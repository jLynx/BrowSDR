import { expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ReceiverView } from '../helpers/receiver-view';
import { HackRFDevice } from '@/devices/hackrf/device';

it('runs Balanced from the main button and selected preferences from the disclosure', async () => {
	const wrapper = mount(ReceiverView);
	const run = vi.spyOn(wrapper.vm, 'autoSetGains').mockResolvedValue(undefined);
	await wrapper.setData({
		deviceCapabilities: new HackRFDevice(),
		gains: { LNA: 16, VGA: 16, 'Amp (14dB)': 0 },
		connected: true,
		running: true,
	});
	const actions = wrapper.get('.auto-gain');
	await actions.get('.ui-menu-split > button').trigger('click');
	expect(run).toHaveBeenLastCalledWith('balanced');
	const trigger = actions.get('[aria-label="Auto gain preferences"]');
	for (const [label, mode] of [
		['Weak signals', 'sensitivity'],
		['Strong signals', 'strong'],
		['Balanced', 'balanced'],
	]) {
		await trigger.trigger('click');
		await actions.get(`[aria-label="${label}"]`).trigger('click');
		expect(run).toHaveBeenLastCalledWith(mode);
		expect(trigger.attributes('aria-expanded')).toBe('false');
	}
	await actions.get('.ui-menu-split > button').trigger('click');
	expect(run).toHaveBeenLastCalledWith('balanced');
	await wrapper.setData({ autoGain: { active: true } });
	expect(actions.get('.ui-menu-split > button').attributes('disabled')).toBeDefined();
	expect(trigger.attributes('disabled')).toBeDefined();
	wrapper.unmount();
});
