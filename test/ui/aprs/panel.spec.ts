import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ReceiverView } from '../helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';
import type { AprsMessage } from '@/worker/decoders/aprs/types';

vi.mock('leaflet', () => ({}));
vi.mock('@/app/decoders/aprs/map', () => ({
	AprsMap: vi.fn().mockImplementation(() => ({ update: vi.fn(), destroy: vi.fn(), fit: vi.fn(), resize: vi.fn(), focus: vi.fn() })),
}));
let wrapper: VueWrapper;
afterEach(() => {
	wrapper?.unmount();
	vi.clearAllMocks();
});

function aprsMessage(now: number): AprsMessage {
	return {
		type: 'aprs',
		freq: 144.39,
		status: { state: 'receiving', message: 'Listening', samples: 1000, frames: 3 },
		stations: [
			{
				id: 'N0CALL-9',
				type: 'station',
				lastSeen: now,
				packets: 2,
				symbol: '/>',
				latitude: 49.05833,
				longitude: -72.02917,
				positionTime: now,
				course: 88,
				speed: 66.7,
				comment: 'Mobile',
				path: 'WIDE1-1*',
				weather: { temperature: 21.5, humidity: 40 },
				weatherTime: now,
				telemetry: { sequence: '005', analog: [125, 60] },
				telemetryTime: now,
				telemetryDefinition: { names: ['Battery', 'Temp'], units: ['V', 'C'], equations: [[0, 0.1, 0]] },
				trail: [],
			},
		],
		packets: [
			{
				id: 1,
				receivedAt: now,
				source: 'N0CALL-9',
				destination: 'APRS',
				path: ['WIDE1-1*'],
				info: '!4903.50N/07201.75W>088/036Mobile',
				kind: 'position',
				symbol: '/>',
				latitude: 49.05833,
				longitude: -72.02917,
				comment: 'Mobile',
			},
			{
				id: 2,
				receivedAt: now,
				source: 'N0CALL-9',
				destination: 'APRS',
				path: [],
				info: ':WU2Z     :Testing{003',
				kind: 'message',
				message: { kind: 'message', addressee: 'WU2Z', text: 'Testing', id: '003' },
			},
		],
	};
}

describe('APRS panel', () => {
	it('tunes and enables a muted VFO, and keeps decoding after the panel closes', async () => {
		wrapper = mount(ReceiverView);
		const setVfoParams = vi.fn();
		await wrapper.setData({
			running: true,
			backend: { setVfoParams },
			vfos: [makeDefaultVfo(100)],
			aprs: { panelOpen: true, sources: [], status: [] },
		});
		expect(wrapper.get('input[aria-label="APRS decoding for VFO 1"]').attributes('disabled')).toBeDefined();
		await wrapper.get('select[aria-label="APRS channel"]').setValue('144.8');
		const tune = wrapper.findAll('.aprs-panel button').find((button) => button.text() === 'Tune APRS channel')!;
		await tune.trigger('click');
		expect(wrapper.vm.vfos[0].freq).toBe(144.8);
		await wrapper.get('input[aria-label="APRS decoding for VFO 1"]').setValue(true);
		expect(wrapper.vm.vfos[0]).toMatchObject({ aprs: true, enabled: false });
		expect(setVfoParams).toHaveBeenLastCalledWith(0, expect.objectContaining({ aprs: true, enabled: false }));
		await wrapper.get('button[aria-label="Close APRS panel"]').trigger('click');
		expect(wrapper.vm.vfos[0].aprs).toBe(true);
	});
	it('shows stations, details with weather and scaled telemetry, and the packet log', async () => {
		wrapper = mount(ReceiverView);
		await wrapper.setData({
			running: true,
			vfos: [{ ...makeDefaultVfo(144.39), aprs: true }],
			aprs: { panelOpen: true, sources: [], status: [] },
		});
		const message = aprsMessage(Date.now());
		wrapper.vm._onAprsMessage(0, 144.8, message);
		expect(wrapper.vm.aprs.sources).toEqual([]);
		wrapper.vm._onAprsMessage(0, 144.39, message);
		await wrapper.vm.$nextTick();
		const rows = wrapper.get('.aprs-panel tbody').text();
		for (const value of ['N0CALL-9', 'Car', 'Mobile', '67 km/h · 88°']) expect(rows).toContain(value);
		await wrapper.get('.aprs-panel tbody button').trigger('click');
		const details = wrapper.get('[aria-label="APRS station details"]').text();
		for (const value of [
			'49.05833°N 72.02917°W',
			'WIDE1-1*',
			'21.5 °C',
			'40%',
			'Battery',
			'12.5 V',
			'Temp',
			'60 C',
			'To WU2Z: Testing (#003)',
		])
			expect(details).toContain(value);
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Back to stations')!
			.trigger('click');
		await wrapper
			.findAll('.aprs-toolbar button')
			.find((button) => button.text() === 'Packets')!
			.trigger('click');
		await wrapper.get('select[aria-label="APRS packet type"]').setValue('message');
		const packets = wrapper.get('.aprs-packets tbody').text();
		expect(packets).toContain('To WU2Z: Testing (#003)');
		expect(packets).not.toContain('Mobile');
		expect(wrapper.get('.aprs-panel .adsb-summary').text()).toContain('3 valid frames');
	});
});
