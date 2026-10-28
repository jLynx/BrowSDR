import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { ReceiverView } from '../helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';
import type { RtkMessage } from '@/worker/decoders/rtk/types';
import { downloadReport, downloadCorrections } from '@/app/decoders/rtk/downloads';

vi.mock('@/app/decoders/rtk/downloads', () => ({ downloadReport: vi.fn(), downloadCorrections: vi.fn() }));

let wrapper: VueWrapper<InstanceType<typeof ReceiverView>>;
afterEach(() => {
	wrapper?.unmount();
	vi.clearAllMocks();
});

const message = (frequency = 923.118): RtkMessage => ({
	type: 'rtk',
	freq: frequency,
	status: {
		state: 'receiving',
		message: 'Listening',
		samples: 1000000,
		syncs: 1,
		headers: 1,
		packets: 1,
		crcErrors: 0,
		discontinuities: 0,
	},
	stations: [
		{
			name: 'RTK base station',
			scan: 1234,
			channel: 7,
			netId: 42,
			packets: 1,
			lastSeen: Date.now(),
			lastCorrection: Date.now(),
			rtcmCount: 1,
			rtcmTypes: { 1074: 1 },
			cfoHz: 0,
		},
	],
	rtcm: [{ type: 1074, stationId: 1, data: new Uint8Array([0xd3]) }],
});

async function setup() {
	wrapper = mount(ReceiverView);
	await wrapper.setData({
		running: true,
		connected: true,
		backend: { setVfoParams: vi.fn() },
		vfos: [{ ...makeDefaultVfo(923.118), enabled: false }],
	});
}

describe('live RTK receiver tools', () => {
	it('tunes only the selected muted VFO with the RTK2 preset and retains RTK1 tuning', async () => {
		await setup();
		wrapper.vm.vfos.push({ ...makeDefaultVfo(924.116), enabled: false });
		wrapper.vm.rtk.panelOpen = true;
		await nextTick();
		const profile = wrapper.get('select[aria-label="RTK signal profile"]');
		expect(profile.findAll('option').map((option) => option.text())).toEqual([
			'Mammotion RTK1 · 500 kHz',
			'Mammotion RTK2 · 250 kHz',
			'Mammotion RTK3 · 250 kHz (experimental)',
			'LoRa · 250 kHz (experimental)',
		]);
		await wrapper.get('select[aria-label="RTK VFO"]').setValue(1);
		await profile.setValue('rtk2');
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Tune to 915.191 MHz')!
			.trigger('click');
		expect(wrapper.vm.vfos[1]).toMatchObject({ freq: 915.191, rtkProfile: 'rtk2', rtkClockPpm: 10, enabled: false, rtk: false });
		expect(wrapper.vm.vfos[0]).toMatchObject({ freq: 923.118, rtkProfile: 'luba1', enabled: false });
		expect(wrapper.vm.backend!.setVfoParams).toHaveBeenLastCalledWith(
			1,
			expect.objectContaining({ freq: 915.191, rtkProfile: 'rtk2', rtkClockPpm: 10, enabled: false, rtk: false }),
		);
		await profile.setValue('luba1');
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Tune to 923.118 MHz')!
			.trigger('click');
		expect(wrapper.vm.vfos[1]).toMatchObject({ freq: 923.118, rtkProfile: 'luba1', rtkClockPpm: 20, enabled: false });
	});

	it('selects RTK2 with measured timing and exports verified corrections by network and address', async () => {
		await setup();
		wrapper.vm.rtk.panelOpen = true;
		wrapper.vm.vfos[0].rtk = true;
		await nextTick();
		await wrapper.get('select[aria-label="RTK signal profile"]').setValue('rtk2');
		expect(wrapper.vm.vfos[0]).toMatchObject({ rtkProfile: 'rtk2', rtkClockPpm: 10, freq: 923.118 });
		const packet = message();
		packet.profile = 'rtk2';
		packet.stations = [{ ...packet.stations[0], protocol: 'rtk2', network: '544553544e455431', address: 4242, netId: 0 }];
		packet.rtcm[0].source = 'rtk2-544553544e455431-4242';
		packet.status.beacons = 1;
		wrapper.vm._onRtkMessage(0, 923.118, packet);
		await nextTick();
		expect(wrapper.get('[aria-label="LoRa station address"]').text()).toContain('address 4242');
		expect(wrapper.get('.rtk-diagnostics').text()).toContain('Verified keepalives1');
		expect(wrapper.text()).toContain('RTK2 station address: 4242');
		await wrapper.get('select[aria-label="RTK export format"]').setValue('corrections');
		await wrapper
			.findAll('.rtk-section button')
			.find((button) => button.text() === 'Download file')!
			.trigger('click');
		expect(downloadCorrections).toHaveBeenCalledWith(packet.rtcm, 923.118, packet.rtcm[0].source);
	});

	it('selects RTK3 without a guessed frequency, clears prior-profile results and exports by address', async () => {
		await setup();
		wrapper.vm.rtk.panelOpen = true;
		wrapper.vm.vfos[0].rtk = true;
		wrapper.vm._onRtkMessage(0, 923.118, message());
		await nextTick();
		await wrapper.get('select[aria-label="RTK signal profile"]').setValue('rtk3');
		expect(wrapper.vm.vfos[0]).toMatchObject({ rtkProfile: 'rtk3', rtkClockPpm: 0, freq: 923.118, enabled: false });
		expect(wrapper.vm.rtk.frames[0]).toEqual([]);
		expect(wrapper.find('[aria-label="LoRa number"]').exists()).toBe(false);
		expect(wrapper.findAll('button').some((button) => button.text().startsWith('Tune to'))).toBe(false);
		expect(wrapper.text()).toContain('automatic hop following is not available');
		wrapper.vm._onRtkMessage(0, 923.118, { ...message(), profile: 'luba1' });
		expect(wrapper.vm.rtk.sources[0]).toEqual([]);
		const packet = message();
		packet.profile = 'rtk3';
		packet.stations = [{ ...packet.stations[0], scan: undefined, channel: undefined, netId: 4242, address: 4242 }];
		packet.rtcm[0].source = 'rtk3-4242';
		packet.status.beacons = 1;
		packet.status.containers = 1;
		wrapper.vm._onRtkMessage(0, 923.118, packet);
		await nextTick();
		expect(wrapper.get('[aria-label="LoRa station address"]').text()).toContain('address 4242');
		expect(wrapper.get('.rtk-heading').text()).not.toContain('loc unknown');
		expect(wrapper.get('.rtk-diagnostics').text()).toContain('Verified beacons1');
		await wrapper.get('select[aria-label="RTK export format"]').setValue('corrections');
		await wrapper
			.findAll('.rtk-section button')
			.find((button) => button.text() === 'Download file')!
			.trigger('click');
		expect(downloadCorrections).toHaveBeenCalledWith(packet.rtcm, 923.118, 'rtk3-4242');
		wrapper.vm.tuneRtkVfo(924.6);
		expect(wrapper.vm.vfos[0].rtkProfile).toBe('rtk3');
	});

	it('distinguishes verified RTK3 beacons from verified correction data', async () => {
		await setup();
		wrapper.vm.rtk.panelOpen = true;
		wrapper.vm.vfos[0].rtk = true;
		wrapper.vm.vfos[0].rtkProfile = 'rtk3';
		const packet = { ...message(), profile: 'rtk3' as const, stations: [], rtcm: [] };
		packet.status.beacons = 1;
		wrapper.vm._onRtkMessage(0, 923.118, packet);
		await nextTick();
		expect(wrapper.get('.rtk-heading .rtk-state').text()).toBe('Verified beacons');
		expect(wrapper.find('[aria-label="Base station position"]').exists()).toBe(false);
		expect(wrapper.find('[aria-label="RTK base stations"]').exists()).toBe(false);
		packet.status = { ...packet.status, beacons: 0, containers: 0 };
		wrapper.vm._onRtkMessage(0, 923.118, packet);
		await nextTick();
		expect(wrapper.get('.rtk-heading .rtk-state').text()).toBe('Verified radio frames');
	});
	it('opens without enabling, decodes muted VFOs, and continues with the panel closed', async () => {
		await setup();
		await wrapper.get('.tools-trigger').trigger('click');
		await wrapper.get('button[aria-label="RTK"]').trigger('click');
		expect(wrapper.vm.vfos[0].rtk).toBe(false);
		await wrapper.get('input[aria-label="RTK decoding for VFO 1"]').setValue(true);
		expect(wrapper.vm.backend!.setVfoParams).toHaveBeenLastCalledWith(0, expect.objectContaining({ rtk: true, enabled: false }));
		wrapper.vm._onRtkMessage(0, 923.118, message());
		await nextTick();
		expect(wrapper.get('.rtk-heading .rtk-state').text()).toBe('Live corrections');
		expect(wrapper.findAll('.rtk-section').every((section) => !(section.element as HTMLDetailsElement).open)).toBe(true);
		expect(wrapper.get('[aria-label="LoRa number"]').text()).toContain('1234.7.?.42');
		expect(wrapper.get('[aria-label="LoRa number"]').text()).toContain('loc unknown');
		expect(wrapper.findAll('button').some((button) => button.text() === 'Clear saved messages')).toBe(false);
		await wrapper.get('button[aria-label="Close RTK decoder"]').trigger('click');
		wrapper.vm._onRtkMessage(0, 923.118, message());
		expect(wrapper.vm.rtk.frames[0]).toHaveLength(2);
		expect(wrapper.vm.vfos[0].rtk).toBe(true);
	});

	it('shows the selected base position and satellite observations using general RTK wording', async () => {
		await setup();
		wrapper.vm.rtk.panelOpen = true;
		wrapper.vm.vfos[0].rtk = true;
		const packet = message();
		packet.stations[0].reference = {
			stationId: 42,
			itrf: 20,
			latitude: 0,
			longitude: 0,
			heightM: 10,
			ecef: [1, 2, 3],
			antennaHeightM: 0,
		};
		packet.stations[0].equipment = {
			stationId: 42,
			antenna: 'ANT',
			setupId: 0,
			antennaSerial: '',
			receiver: 'UNICORE UM960',
			firmware: '1.2',
			receiverSerial: '',
		};
		packet.stations[0].observations = {
			GPS: {
				type: 1074,
				stationId: 42,
				constellation: 'GPS',
				epochMs: 123456,
				multipleMessage: false,
				satellites: [1, 3, 32],
				signals: [2, 8],
				cells: 3,
				cnrDbHz: [35, 42, 49],
				measurements: [
					{ satellite: 1, signal: 2, cnrDbHz: 35, band: 'L1', group: 'primary' },
					{ satellite: 3, signal: 8, cnrDbHz: 42, band: 'L2', group: 'secondary' },
					{ satellite: 32, signal: 2, cnrDbHz: 49, band: 'L1', group: 'primary' },
				],
				receivedAt: Date.now(),
			},
		};
		wrapper.vm._onRtkMessage(0, 923.118, packet);
		await nextTick();
		expect(wrapper.get('[aria-label="Base station position"]').text()).toContain('0.0000000°, 0.0000000°');
		expect(wrapper.get('[aria-label="Satellite observations"] strong').text()).toBe('3');
		expect(wrapper.get('[aria-label="Satellites by constellation"]').text()).toContain('GPS3');
		expect(wrapper.get('.rtk-heading h3').text()).toBe('UNICORE UM960');
		expect(wrapper.get('[aria-label="Satellites by frequency group"]').text()).toContain('L1 / primary2');
		expect(wrapper.get('[aria-label="Satellites by frequency group"]').text()).toContain('L2 / secondary1');
		expect(wrapper.get('[aria-label="GNSS signal quality"]').text()).toContain('Good');
		expect(wrapper.find('[aria-label="Base station location map"]').exists()).toBe(true);
		expect(wrapper.get('[aria-label="Live RTK decoder"]').text()).toContain('42.0 dB-Hz');
		expect(wrapper.find('[aria-label="Rover fix status"]').exists()).toBe(false);
		expect(wrapper.get('[aria-label="Live RTK decoder"]').text()).not.toContain('mower');
	});

	it('bounds saved messages and rejects stopped, disabled and stale-frequency updates', async () => {
		await setup();
		wrapper.vm.vfos[0].rtk = true;
		const packet = message();
		packet.rtcm = Array.from({ length: 600 }, (_, stationId) => ({ ...packet.rtcm[0], stationId }));
		wrapper.vm._onRtkMessage(0, 923.118, packet);
		expect(wrapper.vm.rtk.frames[0]).toHaveLength(512);
		expect(wrapper.vm.rtk.frames[0][0].stationId).toBe(88);
		wrapper.vm._onRtkMessage(0, 923.118, message(915.19));
		wrapper.vm._onRtkMessage(0, 915.19, message(915.19));
		wrapper.vm.vfos[0].rtk = false;
		wrapper.vm._onRtkMessage(0, 923.118, message());
		wrapper.vm.vfos[0].rtk = true;
		wrapper.vm.running = false;
		wrapper.vm._onRtkMessage(0, 923.118, message());
		expect(wrapper.vm.rtk.frames[0]).toHaveLength(512);
	});

	it('shows only the selected channel and explains an undecoded signal', async () => {
		await setup();
		wrapper.vm.rtk.panelOpen = true;
		wrapper.vm.vfos[0].rtk = true;
		wrapper.vm._onRtkMessage(0, 923.118, message());
		wrapper.vm.vfos.push({ ...makeDefaultVfo(915.19), rtk: true, rtkProfile: 'lower' });
		const lower = message(915.19);
		lower.stations = [];
		lower.rtcm = [];
		lower.status.packets = 0;
		wrapper.vm._onRtkMessage(1, 915.19, lower);
		await nextTick();
		await wrapper.get('select[aria-label="RTK VFO"]').setValue('1');
		expect(wrapper.get('.rtk-heading .rtk-state').text()).toBe('Payload undecoded');
		lower.status = { ...lower.status, payloads: 17, codingErrors: 2, syncSymbols: [16, 8] };
		wrapper.vm._onRtkMessage(1, 915.19, lower);
		await nextTick();
		expect(wrapper.get('.rtk-heading .rtk-state').text()).toBe('Payload unverified');
		const diagnostics = wrapper.get('.rtk-diagnostics').text();
		expect(diagnostics).toContain('Payloads recovered17');
		expect(diagnostics).toContain('Coding parity errors2');
		expect(diagnostics).toContain('Observed LoRa sync symbols16, 8');
		expect(wrapper.get('.rtk-empty').text()).toContain('Select a base from the list');
		expect(wrapper.find('[aria-label="Base station position"]').exists()).toBe(false);
		expect(wrapper.find('[aria-label="LoRa number"]').exists()).toBe(false);
	});

	it('downloads a clearly named format for the selected channel only', async () => {
		await setup();
		wrapper.vm.rtk.panelOpen = true;
		wrapper.vm.vfos[0].rtk = true;
		const packet = message();
		wrapper.vm._onRtkMessage(0, 923.118, packet);
		await nextTick();
		await wrapper.get('select[aria-label="RTK export format"]').setValue('corrections');
		const download = wrapper.findAll('.rtk-section button').find((button) => button.text() === 'Download file')!;
		await download.trigger('click');
		expect(downloadCorrections).toHaveBeenCalledWith(packet.rtcm, 923.118, '1234.7.42');
		await wrapper.get('select[aria-label="RTK export format"]').setValue('report');
		await download.trigger('click');
		expect(downloadReport).toHaveBeenCalledWith(
			expect.objectContaining({ frequency: 923.118, profile: 'luba1', stations: packet.stations }),
		);
	});

	it('hides old station results on retune and replaces saved corrections for the new frequency', async () => {
		await setup();
		wrapper.vm.vfos[0].rtk = true;
		wrapper.vm.rtk.panelOpen = true;
		wrapper.vm._onRtkMessage(0, 923.118, message());
		wrapper.vm.vfos[0].freq = 915.19;
		await nextTick();
		expect(wrapper.find('[aria-label="LoRa number"]').exists()).toBe(false);
		expect(wrapper.get('.rtk-heading .rtk-state').text()).toBe('Listening');
		const lower = message(915.19);
		lower.stations = [];
		lower.rtcm = [];
		wrapper.vm._onRtkMessage(0, 915.19, lower);
		expect(wrapper.vm.rtk.frames[0]).toEqual([]);
		await wrapper.get('select[aria-label="RTK signal profile"]').setValue('lower');
		expect(wrapper.vm.vfos[0].rtkClockPpm).toBe(10);
	});
});
