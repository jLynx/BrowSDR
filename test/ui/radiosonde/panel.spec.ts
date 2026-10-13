import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ReceiverView } from '../helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';

vi.mock('leaflet', () => ({}));
vi.mock('@/app/decoders/radiosonde/map', () => ({
	SondeMap: vi.fn().mockImplementation(() => ({ update: vi.fn(), destroy: vi.fn(), fit: vi.fn(), resize: vi.fn(), focus: vi.fn() })),
}));
let wrapper: VueWrapper;
afterEach(() => {
	wrapper?.unmount();
	vi.clearAllMocks();
});
describe('Radiosonde panel', () => {
	it('enables a muted VFO and keeps decoding after the panel closes', async () => {
		wrapper = mount(ReceiverView);
		const setVfoParams = vi.fn();
		await wrapper.setData({
			running: true,
			backend: { setVfoParams },
			vfos: [makeDefaultVfo(403)],
			radiosonde: { panelOpen: true, sources: [], status: [] },
		});
		await wrapper.get('input[aria-label="Radiosonde decoding for VFO 1"]').setValue(true);
		expect(wrapper.vm.vfos[0]).toMatchObject({ radiosonde: true, enabled: false });
		expect(setVfoParams).toHaveBeenLastCalledWith(0, expect.objectContaining({ radiosonde: true, enabled: false }));
		await wrapper.get('button[aria-label="Close radiosonde panel"]').trigger('click');
		expect(wrapper.vm.vfos[0].radiosonde).toBe(true);
	});
	it('displays balloon telemetry and rejects a message from an old frequency', async () => {
		wrapper = mount(ReceiverView);
		await wrapper.setData({
			running: true,
			vfos: [{ ...makeDefaultVfo(403), radiosonde: true }],
			radiosonde: { panelOpen: true, sources: [], status: [] },
		});
		const now = Date.now();
		const sonde = {
			id: 'V1234567',
			model: 'RS41' as const,
			frame: 42,
			frequency: 403,
			lastSeen: now,
			messages: 1,
			latitude: -36.85,
			longitude: 174.76,
			altitude: 12345,
			climb: 5.1,
			battery: 2.9,
			temperature: -42.5,
			humidity: 10.3,
			subtype: 'RS41-SGE',
			mainboard: 'RSM415',
			maxAltitude: 12400,
			killCountdown: -1,
			calibrationCount: 51,
			calibrationTotal: 51,
			configuration: [{ label: 'CPU temperature', value: 12, unit: '°C' }],
			rawBlocks: [{ type: 0x7a, data: '00ff', crcValid: true }],
			positionTime: now,
			trail: [],
		};
		const message = {
			type: 'radiosonde' as const,
			freq: 403,
			status: { state: 'receiving' as const, message: 'Listening', samples: 1000, frames: 1, syncs: 10, crcErrors: 0 },
			sondes: [sonde],
		};
		wrapper.vm._onRadiosondeMessage(0, 402, message);
		expect(wrapper.vm.radiosonde.sources).toEqual([]);
		wrapper.vm._onRadiosondeMessage(0, 403, message);
		await wrapper.vm.$nextTick();
		expect(wrapper.get('.radiosonde-panel tbody').text()).toContain('12345 m');
		await wrapper.get('.radiosonde-panel tbody button').trigger('click');
		expect(wrapper.get('[aria-label="Balloon details"]').text()).toContain('2.9 V');
		const details = wrapper.get('[aria-label="Balloon details"]').text();
		for (const value of ['-42.5 °C', '10.3%', 'RS41-SGE', 'RSM415', '12400 m', 'Inactive', '51 / 51']) expect(details).toContain(value);
		expect(details).toContain('Raw telemetry and calibration');
	});
});
