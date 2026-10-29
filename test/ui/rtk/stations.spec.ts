import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { ReceiverView } from '../helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';
import { downloadReport, downloadCorrections } from '@/app/decoders/rtk/downloads';
import { mockStation, mockStationMessage, mockPairingStorage } from './fixtures';

vi.mock('@/app/decoders/rtk/downloads', () => ({ downloadReport: vi.fn(), downloadCorrections: vi.fn() }));
const maps = vi.hoisted(() => ({ update: vi.fn(), destroy: vi.fn() }));
vi.mock('leaflet', () => ({}));
vi.mock('@/app/decoders/rtk/map', () => ({
	BaseMap: class {
		update = maps.update;
		destroy = maps.destroy;
	},
}));

let wrapper: VueWrapper<InstanceType<typeof ReceiverView>>;
beforeEach(() => vi.stubGlobal('localStorage', mockPairingStorage()));
afterEach(() => {
	wrapper?.unmount();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

async function setup(frequencies = [923.118, 921.25]) {
	wrapper = mount(ReceiverView);
	await wrapper.setData({
		running: true,
		connected: true,
		centerFreq: 922,
		sampleRate: 20000000,
		backend: { setVfoParams: vi.fn(), removeVfo: vi.fn() },
		vfos: frequencies.map((frequency) => ({ ...makeDefaultVfo(frequency), enabled: false, rtk: true })),
	});
	wrapper.vm.rtk.panelOpen = true;
}

const rows = () => wrapper.findAll('.rtk-station-list tbody tr');

describe('combined RTK station list', () => {
	it('shows entered estimates in amber in both views without changing decoded reports or receiver settings', async () => {
		await setup([923.118]);
		wrapper.vm.vfos[0].rtkProfile = 'rtk2';
		const station = { ...mockStation(), protocol: 'rtk2' as const, network: '3030303030303030', loc: 0, address: 42 };
		wrapper.vm._onRtkMessage(0, 923.118, { ...mockStationMessage(923.118, [station]), profile: 'rtk2' });
		await nextTick();
		await wrapper.get('input[aria-label="Estimated scan"]').setValue('903');
		await wrapper.get('input[aria-label="Estimated channel"]').setValue('7');
		expect(wrapper.get('[aria-label="LoRa number"] .rtk-lora-number').text()).toBe('903.7.0.42');
		expect(wrapper.findAll('.rtk-lora-number .rtk-estimate').map((p) => p.text())).toEqual(['903', '7']);
		expect(
			rows()[0]
				.findAll('span[title]')
				.map((p) => p.text()),
		).toEqual(['903', '7']);
		expect(rows()[0].text()).toContain('Amber = estimate');
		expect(wrapper.get('input[aria-label="Estimated scan"]').element).toHaveProperty('value', '903');
		expect(wrapper.find('input[aria-label="Estimated local ID"]').exists()).toBe(false);
		const download = wrapper.findAll('.rtk-section button').find((button) => button.text() === 'Download file')!;
		await download.trigger('click');
		expect(downloadReport).toHaveBeenLastCalledWith(expect.objectContaining({ stations: [station] }));
		expect(wrapper.vm.rtk.sources[0][0]).toEqual(station);
		expect(wrapper.vm.backend!.setVfoParams).not.toHaveBeenCalled();
		await wrapper.get('input[aria-label="Estimated scan"]').setValue('');
		expect(wrapper.get('.rtk-lora-number').text()).toBe('?.7.0.42');
	});

	it('labels every Mammotion generation independently across same-frequency VFOs and follows station selection', async () => {
		await setup([923.118, 923.118, 923.118]);
		const profiles = ['rtk1', 'rtk2', 'rtk3'] as const;
		for (const [index, profile] of profiles.entries()) {
			wrapper.vm.vfos[index].rtkProfile = profile;
			const station = mockStation();
			if (profile === 'rtk2') Object.assign(station, { protocol: 'rtk2', network: '3030303030303030', loc: 0, address: 42 });
			if (profile === 'rtk3') Object.assign(station, { scan: undefined, channel: undefined, address: 42 });
			wrapper.vm._onRtkMessage(index, 923.118, { ...mockStationMessage(923.118, [station]), profile });
		}
		await nextTick();
		expect(rows()).toHaveLength(3);
		for (const [index, profile] of profiles.entries()) {
			const label = `Mammotion ${profile.toUpperCase()}`;
			const row = rows().find((row) => row.get('strong').text() === label)!;
			expect(row.text()).toContain('MOCK GNSS');
			expect(row.text()).toContain(`VFO ${index + 1}`);
			await row.get('button').trigger('click');
			expect(wrapper.vm.activeVfoIndex).toBe(index);
			expect(wrapper.get('.rtk-heading h3').text()).toBe(label);
			expect(wrapper.get('[aria-label="GNSS receiver"]').text()).toBe('GNSS receiver: MOCK GNSS');
		}
		expect(wrapper.vm.backend!.setVfoParams).not.toHaveBeenCalled();
	});

	it('uses the broadcast equipment receiver and keeps manufacturer-only and unreported models honest', async () => {
		await setup([923.118]);
		wrapper.vm.vfos[0].rtkProfile = 'rtk2';
		const station = {
			...mockStation(),
			name: 'RTK base station',
			protocol: 'rtk2' as const,
			network: '3030303030303030',
			loc: 0,
			address: 42,
		};
		const send = async () => {
			wrapper.vm._onRtkMessage(0, 923.118, { ...mockStationMessage(923.118, [station]), profile: 'rtk2' });
			await nextTick();
		};
		await send();
		expect(wrapper.get('.rtk-heading h3').text()).toBe('Mammotion RTK2');
		expect(wrapper.get('[aria-label="GNSS receiver"]').text()).toContain('Receiver model not reported');
		expect(rows()[0].text()).toContain('Receiver model not reported');
		station.name = 'UNICORE';
		await send();
		expect(wrapper.get('[aria-label="GNSS receiver"]').text()).toBe('GNSS receiver: UNICORE');
		expect(rows()[0].text()).not.toContain('UM960');
		Object.assign(station, {
			equipment: {
				stationId: 42,
				antenna: '',
				setupId: 0,
				antennaSerial: '',
				receiver: '  UNICORE UM960  ',
				firmware: '',
				receiverSerial: '',
			},
		});
		await send();
		expect(wrapper.get('[aria-label="GNSS receiver"]').text()).toBe('GNSS receiver: UNICORE UM960');
		expect(rows()[0].text()).toContain('UNICORE UM960');
	});

	it('keeps the discovered-station pane visible before any stations arrive', async () => {
		await setup();
		await nextTick();
		const directory = wrapper.get('[aria-label="Discovered RTK base stations"]');
		expect(directory.text()).toContain('0 base stations');
		expect(directory.text()).toContain('Waiting for RTK base stations');
		expect(wrapper.get('[aria-label="Selected RTK base station"]').find('.rtk-section').exists()).toBe(true);
		expect(directory.find('.rtk-section').exists()).toBe(false);
	});

	it('selects same-frequency bases and other VFOs without mixing corrections or moving selection on updates', async () => {
		await setup();
		const a = mockStation(),
			b = mockStation(2345, 90),
			c = mockStation(3456);
		b.lastCorrection = Date.now() - 10000;
		const shared = mockStationMessage(923.118, [a, b]),
			other = mockStationMessage(921.25, [c]);
		shared.rtcm.push({ type: 1006, stationId: 42, data: new Uint8Array([0xd3, 99]) });
		wrapper.vm._onRtkMessage(0, 923.118, shared);
		wrapper.vm._onRtkMessage(1, 921.25, other);
		await nextTick();
		expect(rows()).toHaveLength(3);
		expect(wrapper.get('.rtk-directory').findAll('.rtk-station-list tbody tr')).toHaveLength(3);
		expect(wrapper.get('.rtk-details').find('.rtk-station-list').exists()).toBe(false);
		expect(rows().filter((row) => row.text().includes('923.118 MHz'))).toHaveLength(2);
		const selectB = rows()
			.find((row) => row.text().includes('2345.7.?.42'))!
			.get('button');
		await selectB.trigger('click');
		expect(wrapper.get('[aria-label="LoRa number"]').text()).toContain('2345.7.?.42');
		expect(wrapper.get('.rtk-heading .rtk-state').text()).toBe('Waiting for corrections');
		expect(wrapper.get('[aria-label="Base station position"]').text()).toContain('0.0000000°, 90.0000000°');
		await vi.dynamicImportSettled();
		await flushPromises();
		expect(maps.update).toHaveBeenLastCalledWith(b.reference, expect.any(String), 'Mammotion RTK1 · MOCK GNSS');
		await wrapper.get('select[aria-label="RTK export format"]').setValue('corrections');
		const download = wrapper.findAll('.rtk-section button').find((button) => button.text() === 'Download file')!;
		await download.trigger('click');
		expect(downloadCorrections).toHaveBeenLastCalledWith([shared.rtcm[1]], 923.118, '2345.7.42');
		await wrapper.get('select[aria-label="RTK export format"]').setValue('report');
		await download.trigger('click');
		expect(downloadReport).toHaveBeenLastCalledWith(expect.objectContaining({ stations: [b] }));
		wrapper.vm._onRtkMessage(0, 923.118, { ...shared, stations: [b, { ...a, lastCorrection: Date.now() + 1 }], rtcm: [] });
		await nextTick();
		expect(selectB.attributes('aria-pressed')).toBe('true');
		expect(wrapper.get('[aria-label="LoRa number"]').text()).toContain('2345.7.?.42');
		await rows()
			.find((row) => row.text().includes('3456.7.?.42'))!
			.get('button')
			.trigger('click');
		expect(wrapper.vm.activeVfoIndex).toBe(1);
		expect(wrapper.get('[aria-label="LoRa number"]').text()).toContain('3456.7.?.42');
		await wrapper.get('select[aria-label="RTK export format"]').setValue('corrections');
		await download.trigger('click');
		expect(downloadCorrections).toHaveBeenLastCalledWith(other.rtcm, 921.25, '3456.7.42');
		expect(wrapper.vm.vfos.every((vfo) => vfo.rtk && !vfo.enabled)).toBe(true);
		expect(wrapper.vm.backend!.setVfoParams).not.toHaveBeenCalled();
	});

	it('deduplicates overlapping VFOs, hides disabled/retuned sources and preserves identities when VFO indices shift', async () => {
		await setup([923.118, 923.118, 921.25]);
		const a = mockStation(),
			newer = { ...a, lastCorrection: Date.now() + 1, reference: undefined },
			b = mockStation(2345);
		wrapper.vm._onRtkMessage(0, 923.118, mockStationMessage(923.118, [a]));
		wrapper.vm._onRtkMessage(1, 923.118, mockStationMessage(923.118, [newer]));
		wrapper.vm._onRtkMessage(2, 921.25, mockStationMessage(921.25, [b]));
		await nextTick();
		expect(rows()).toHaveLength(2);
		expect(wrapper.get('[aria-label="Base station position"]').text()).toContain('0.0000000°, 0.0000000°');
		expect(
			rows()
				.find((row) => row.text().includes('1234.7.?.42'))!
				.text(),
		).toContain('VFO 1, 2');
		await rows()
			.find((row) => row.text().includes('2345.7.?.42'))!
			.get('button')
			.trigger('click');
		await wrapper.vm.removeVfo(0);
		await nextTick();
		expect(wrapper.vm.activeVfoIndex).toBe(1);
		expect(wrapper.get('[aria-label="LoRa number"]').text()).toContain('2345.7.?.42');
		expect(
			rows()
				.find((row) => row.text().includes('2345.7.?.42'))!
				.text(),
		).toContain('VFO 2');
		wrapper.vm.vfos[1].rtk = false;
		await nextTick();
		expect(rows()).toHaveLength(1);
		expect(wrapper.find('[aria-label="LoRa number"]').exists()).toBe(false);
		wrapper.vm.vfos[0].freq = 925;
		await nextTick();
		expect(rows()).toHaveLength(0);
	});
});
