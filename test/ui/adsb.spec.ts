import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, type ComponentPublicInstance } from 'vue';
import { makeDefaultVfo } from '@/app/core/constants';
import { ReceiverView } from './helpers/receiver-view';
import { AircraftMap } from '@/app/decoders/adsb/map/leaflet';
import { settingsMethods } from '@/app/radio/settings';
import { vfoMethods } from '@/app/radio/vfo';
import type { AppInstance } from '@/app/core/receiver.types';
import type { AdsbMessage } from '@/worker/decoders/adsb/types';
import { createAppData } from '@/app/core/state';

vi.mock('leaflet', () => ({}));
vi.mock('@/app/decoders/adsb/database/lookup', () => ({
	lookupAircraft: vi.fn().mockResolvedValue(undefined),
	lookupAirline: vi.fn().mockResolvedValue(undefined),
	aircraftClassification: () => ({}),
	DATABASE_SOURCE: 'https://example.com/database',
}));
vi.mock('@/app/decoders/adsb/map/leaflet', () => ({
	AircraftMap: vi.fn().mockImplementation(() => ({
		update: vi.fn(),
		destroy: vi.fn(),
		fit: vi.fn(),
		resize: vi.fn(),
		focus: vi.fn(),
		setAircraftType: vi.fn(),
	})),
}));

let wrapper: VueWrapper;
afterEach(() => {
	wrapper?.unmount();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

const snapshot = (): AdsbMessage => ({
	type: 'adsb',
	freq: 1090,
	status: { state: 'receiving', message: 'Listening', frames: 2, samples: 1000 },
	aircraft: [
		{
			icao: '40621D',
			callsign: 'TEST123',
			altitude: 38000,
			speed: 159,
			heading: 183,
			latitude: 52,
			longitude: 4,
			positionTime: Date.now(),
			lastSeen: Date.now(),
			messages: 2,
		},
	],
});

describe('ADS-B receiver controls and aircraft map', () => {
	it('can look up an ICAO address without live reception and return to the search', async () => {
		wrapper = mount(ReceiverView);
		await wrapper.setData({ adsb: { panelOpen: true, sources: [], status: [] } });
		await wrapper.get('input[aria-label="Search aircraft"]').setValue('c827ee');
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Look up ICAO')!
			.trigger('click');
		expect(wrapper.get('[aria-label="Aircraft details"]').text()).toContain('C827EE');
		expect(wrapper.vm.running).toBe(false);
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Back to aircraft')!
			.trigger('click');
		expect(wrapper.get('input[aria-label="Search aircraft"]').element.value).toBe('c827ee');
		expect(wrapper.find('[aria-label="Aircraft details"]').exists()).toBe(false);
	});
	it('keeps row order and DOM rows stable when aircraft receive messages in a different order', async () => {
		wrapper = mount(ReceiverView);
		await wrapper.setData({
			running: true,
			vfos: [{ ...makeDefaultVfo(1090), adsb: true }],
			adsb: { panelOpen: true, sources: [], status: [] },
		});
		const first = { ...snapshot().aircraft[0], icao: 'A00001', callsign: 'FIRST', lastSeen: Date.now() - 1000 };
		const second = { ...snapshot().aircraft[0], icao: 'B00002', callsign: 'SECOND', lastSeen: Date.now() };
		wrapper.vm._onAdsbMessage(0, 1090, { ...snapshot(), aircraft: [second, first] });
		await nextTick();
		const rows = wrapper.findAll('.adsb-table tbody tr').map((row) => row.element);
		expect(wrapper.findAll('.adsb-table tbody button').map((button) => button.text())).toEqual(['FIRST', 'SECOND']);
		await wrapper.find('.adsb-table tbody button').trigger('click');
		wrapper.vm._onAdsbMessage(0, 1090, {
			...snapshot(),
			aircraft: [{ ...first, callsign: 'RENAMED', lastSeen: Date.now() + 1000 }, second],
		});
		await nextTick();
		expect(wrapper.findAll('.adsb-table tbody button').map((button) => button.text())).toEqual(['RENAMED', 'SECOND']);
		expect(wrapper.findAll('.adsb-table tbody tr').map((row) => row.element)).toEqual(rows);
		expect(wrapper.find('.adsb-table tbody tr').classes()).toContain('selected');
	});
	it('controls decoding for the selected VFO in the tool and requires 1090 MHz before enabling', async () => {
		wrapper = mount(ReceiverView);
		const setVfoParams = vi.fn();
		await wrapper.setData({
			running: true,
			backend: { setVfoParams },
			vfos: [{ ...makeDefaultVfo(1090), mode: 'dsd' }, makeDefaultVfo(1089)],
			adsb: { panelOpen: true, sources: [], status: [] },
		});
		expect(wrapper.vm.vfos[0].adsb).toBe(false);
		await wrapper.get('input[aria-label="ADS-B decoding for VFO 1"]').setValue(true);
		expect(wrapper.vm.vfos[0]).toMatchObject({ mode: 'dsd', adsb: true, enabled: false });
		await wrapper.get('select[aria-label="ADS-B VFO"]').setValue('1');
		expect(wrapper.get('input[aria-label="ADS-B decoding for VFO 2"]').attributes('disabled')).toBeDefined();
		await wrapper.setData({ activeVfoIndex: 0, vfos: [{ ...wrapper.vm.vfos[0], freq: 1089 }, wrapper.vm.vfos[1]] });
		expect(wrapper.get('input[aria-label="ADS-B decoding for VFO 1"]').attributes('disabled')).toBeUndefined();
		await wrapper.get('input[aria-label="ADS-B decoding for VFO 1"]').setValue(false);
		expect(setVfoParams).toHaveBeenLastCalledWith(0, expect.objectContaining({ adsb: false }));
	});
	it('tunes the selected VFO through the normal tuning rules without changing decoder or audio settings', async () => {
		wrapper = mount(ReceiverView);
		await wrapper.setData({
			vfos: [makeDefaultVfo(1089), makeDefaultVfo(1088)],
			activeVfoIndex: 1,
			adsb: { panelOpen: true, sources: [], status: [] },
			radio: { centerFreq: 1089, sampleRate: 4e6 },
		});
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Tune VFO 2 to 1090 MHz')!
			.trigger('click');
		expect(wrapper.vm.vfos.map((v) => v.freq)).toEqual([1089, 1090]);
		expect(wrapper.vm.vfos[1]).toMatchObject({ adsb: false, enabled: false });
		expect(wrapper.vm.radio.sampleRate).toBe(4e6);
		expect(wrapper.vm.radio.centerFreq).toBe(1089);
		expect(wrapper.findAll('.adsb-panel button').some((button) => button.text().includes('Tune VFO'))).toBe(false);
		await wrapper.setData({ activeVfoIndex: 0 });
		expect(wrapper.findAll('.adsb-panel button').some((button) => button.text() === 'Tune VFO 1 to 1090 MHz')).toBe(true);
	});
	it('moves the center when possible and offers the existing conflict dialog when other VFOs cannot fit', async () => {
		wrapper = mount(ReceiverView);
		vi.spyOn(wrapper.vm, 'isFreqInBandwidth').mockImplementation((freq) =>
			vfoMethods.isFreqInBandwidth.call(wrapper.vm as unknown as AppInstance, freq),
		);
		await wrapper.setData({ vfos: [makeDefaultVfo(106.2)], radio: { centerFreq: 106.2, sampleRate: 4e6 } });
		wrapper.vm.tuneAdsbVfo();
		expect(wrapper.vm.vfos[0].freq).toBe(1090);
		expect(wrapper.vm.radio.centerFreq).toBe(1090);
		await wrapper.setData({ vfos: [makeDefaultVfo(106.2), makeDefaultVfo(107)], radio: { centerFreq: 106.2 } });
		wrapper.vm.tuneAdsbVfo(1);
		expect(wrapper.vm.vfoConflictDialog).toMatchObject({ show: true, vfoIndex: 1, requestedFreq: 1090 });
		expect(wrapper.vm.vfos.map((v) => v.freq)).toEqual([106.2, 107]);
	});
	it('respects a remote host center-frequency lock', async () => {
		wrapper = mount(ReceiverView);
		vi.spyOn(wrapper.vm, 'isFreqInBandwidth').mockImplementation((freq) =>
			vfoMethods.isFreqInBandwidth.call(wrapper.vm as unknown as AppInstance, freq),
		);
		const showMsg = vi.spyOn(wrapper.vm, 'showMsg');
		await wrapper.setData({
			vfos: [makeDefaultVfo(106.2)],
			radio: { centerFreq: 106.2, sampleRate: 4e6 },
			remoteMode: 'client',
			locks: { centerFreq: true },
		});
		wrapper.vm.tuneAdsbVfo();
		expect(wrapper.vm.radio.centerFreq).toBe(106.2);
		expect(wrapper.vm.vfos[0].freq).toBeCloseTo(108.2);
		expect(showMsg).toHaveBeenCalledWith(expect.stringContaining('locked by host'));
	});
	it('enables decoding from the tool while audio is muted and preserves other settings', async () => {
		wrapper = mount(ReceiverView);
		const setVfoParams = vi.fn();
		await wrapper.setData({ running: true, connected: true, backend: { setVfoParams }, vfos: [makeDefaultVfo(1090)] });
		expect(wrapper.find('input[aria-label="Decode ADS-B aircraft"]').exists()).toBe(false);
		wrapper.vm.toggleAdsbPanel();
		await nextTick();
		await wrapper.get('input[aria-label="ADS-B decoding for VFO 1"]').setValue(true);
		expect(wrapper.vm.vfos[0].enabled).toBe(false);
		expect(wrapper.vm.vfos[0].adsb).toBe(true);
		expect(wrapper.findAll('button').some((button) => button.text().includes('Tune'))).toBe(false);
		expect(setVfoParams).toHaveBeenCalledWith(0, expect.objectContaining({ adsb: true, enabled: false, freq: 1090 }));
		expect(wrapper.find('[aria-label="ADS-B aircraft"]').exists()).toBe(true);
		await vi.waitFor(() => expect(AircraftMap).toHaveBeenCalledOnce());
		wrapper.vm._onAdsbMessage(0, 1090, snapshot());
		await nextTick();
		expect(wrapper.get('.adsb-table').text()).toContain('TEST123');
		expect(wrapper.get('.adsb-table').text()).toContain('38,000 ft');
		expect(wrapper.text()).toContain('1 aircraft · 1 located');
		await wrapper.get('input[aria-label="Search aircraft"]').setValue('unknown');
		expect(wrapper.text()).toContain('No aircraft match');
		await wrapper.get('button[aria-label="Close ADS-B panel"]').trigger('click');
		expect(wrapper.vm.vfos[0].adsb).toBe(true);
		const map = vi.mocked(AircraftMap).mock.results[0].value as { destroy: ReturnType<typeof vi.fn> };
		expect(map.destroy).toHaveBeenCalledOnce();
	});
	it('keeps telemetry out of unrelated VFO control renders and rejects removed or retuned deliveries', async () => {
		const updates: number[] = [];
		wrapper = mount(ReceiverView, {
			global: {
				mixins: [
					{
						updated(this: ComponentPublicInstance) {
							if (this.$options.name === 'VfoPanel') updates.push((this.$props as { i: number }).i);
						},
					},
				],
			},
		});
		await wrapper.setData({ running: true, vfos: Array.from({ length: 5 }, () => ({ ...makeDefaultVfo(1090), adsb: true })) });
		updates.length = 0;
		wrapper.vm._onAdsbMessage(2, 1090, snapshot());
		await nextTick();
		expect(updates).toEqual([]);
		wrapper.vm._onAdsbMessage(2, 978, { ...snapshot(), aircraft: [] });
		wrapper.vm._onAdsbMessage(7, 1090, { ...snapshot(), aircraft: [] });
		expect(wrapper.vm.adsb.sources[2]).toHaveLength(1);
		await wrapper.vm.removeVfo(1);
		expect(wrapper.vm.adsb.sources[1]).toHaveLength(1);
	});
	it('restores the decoder flag from saved VFO settings', () => {
		const app = { ...createAppData(), settingsKey: 'adsb-test' } as unknown as AppInstance;
		vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ vfos: [{ ...makeDefaultVfo(1090), adsb: true }] }) });
		settingsMethods.loadSetting.call(app);
		expect(app.vfos[0].adsb).toBe(true);
	});
	it('serializes the decoder flag for remote VFO updates', () => {
		const sendCommand = vi.fn();
		const app = {
			backend: {},
			running: true,
			vfos: [{ ...makeDefaultVfo(1090), adsb: true }],
			remoteMode: 'client',
			_webrtc: { sendCommand },
			isFreqInBandwidth: () => true,
		} as unknown as AppInstance;
		vfoMethods.updateBackendVfoParams.call(app, 0);
		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'vfoUpdate', params: expect.objectContaining({ adsb: true, freq: 1090 }) }),
		);
	});
});
