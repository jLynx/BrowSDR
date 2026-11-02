import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { makeDefaultVfo } from '@/app/core/constants';
import { emptyHdStatus } from '@/worker/decoders/hd-radio/types';
import Panel from '@/app/decoders/hd-radio/panel';
import { hdRadioMethods } from '@/app/decoders/hd-radio/feature';
import type { AppInstance } from '@/app/core/receiver.types';
import { ReceiverView } from '../helpers/receiver-view';

describe('HD Radio controls', () => {
	it('offers HD1–HD8 and displays metadata as text', async () => {
		const vfo = { ...makeDefaultVfo(105.3), mode: 'hdradio' };
		const wrapper = mount(Panel, {
			props: {
				vfo,
				status: {
					...emptyHdStatus(),
					state: 'locked',
					message: 'Digital signal locked',
					station: 'KSMG',
					frames: 12,
					programs: [{ program: 0, title: '<script>alert(1)</script>', artist: 'Artist', album: '', genre: '' }],
				},
			},
		});
		expect(wrapper.findAll('option')).toHaveLength(8);
		expect(wrapper.text()).toContain('<script>alert(1)</script>');
		expect(wrapper.find('script').exists()).toBe(false);
		await wrapper.get('select').setValue('1');
		expect(wrapper.emitted('program')?.[0]).toEqual([1]);
		await wrapper.setProps({ vfo: { ...vfo, hdProgram: 1 } });
		expect(wrapper.text()).toContain('HD2 has not been advertised');
		expect(wrapper.text()).not.toContain('Artist');
		wrapper.unmount();
	});

	it('applies the fixed HD bandwidth and stores program selection in VFO state', async () => {
		const wrapper = mount(ReceiverView);
		await wrapper.get('input[aria-label="HD Radio"]').setValue();
		expect(wrapper.vm.vfos[0]).toMatchObject({ mode: 'hdradio', bandwidth: 400000, deEmphasis: 'none' });
		expect(wrapper.get('input[aria-label="Bandwidth"]').attributes('disabled')).toBeDefined();
		await wrapper.get('select[aria-label="HD Radio program"]').setValue('2');
		expect(wrapper.vm.vfos[0].hdProgram).toBe(2);
		expect(wrapper.text()).toContain('Start reception to decode HD Radio');
		wrapper.unmount();
	});

	it('ignores telemetry from removed VFOs, previous frequencies, and other modes', () => {
		const receiver = {
			vfos: [{ ...makeDefaultVfo(105.3), mode: 'hdradio' }],
			hdRadioStatus: [],
			showMsg: vi.fn(),
		} as unknown as AppInstance;
		const status = { ...emptyHdStatus(), station: 'KSMG' };
		hdRadioMethods._onHdRadioMessage.call(receiver, 0, 105.3, { type: 'hd_radio', freq: 105.3, status });
		expect(receiver.hdRadioStatus[0]).toEqual(status);
		receiver.vfos[0].freq = 106.1;
		hdRadioMethods._onHdRadioMessage.call(receiver, 0, 105.3, { type: 'hd_radio', freq: 105.3, status: emptyHdStatus() });
		expect(receiver.hdRadioStatus[0]?.station).toBe('KSMG');
		hdRadioMethods._onHdRadioMessage.call(receiver, 1, 105.3, { type: 'hd_radio', freq: 105.3, status });
		expect(receiver.hdRadioStatus).toHaveLength(1);
	});
});
