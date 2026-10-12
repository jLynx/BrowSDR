import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, type ComponentPublicInstance } from 'vue';
import { ReceiverView } from '../helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';
import type { AcarsMessage } from '@/worker/decoders/acars/types';

let wrapper: VueWrapper;
afterEach(() => {
	wrapper?.unmount();
	vi.clearAllMocks();
});
const message = (): AcarsMessage => ({
	type: 'acars',
	freq: 131.55,
	status: { state: 'receiving', message: 'Listening', samples: 1000, frames: 1 },
	messages: [
		{
			id: 1,
			receivedAt: Date.now(),
			registration: 'ZK-NZE',
			mode: '2',
			acknowledgement: 'NAK',
			label: 'H1',
			blockId: '1',
			direction: 'downlink',
			flight: 'ANZ001',
			messageNumber: 'M01A',
			text: 'ARRIVAL GATE 12\r\n<script>test</script>',
			continuation: false,
		},
	],
});

describe('ACARS receiver tools', () => {
	it('controls the selected VFO with muted audio and preserves decoding when closed', async () => {
		wrapper = mount(ReceiverView);
		const setVfoParams = vi.fn();
		await wrapper.setData({
			running: true,
			backend: { setVfoParams },
			vfos: [makeDefaultVfo(131.55), makeDefaultVfo(100)],
			acars: { panelOpen: true, sources: [], status: [] },
		});
		await wrapper.get('input[aria-label="ACARS decoding for VFO 1"]').setValue(true);
		expect(wrapper.vm.vfos[0]).toMatchObject({ acars: true, enabled: false });
		expect(setVfoParams).toHaveBeenLastCalledWith(0, expect.objectContaining({ acars: true, enabled: false }));
		await wrapper.get('select[aria-label="ACARS VFO"]').setValue('1');
		expect(wrapper.get('input[aria-label="ACARS decoding for VFO 2"]').attributes('disabled')).toBeDefined();
		await wrapper.get('button[aria-label="Close ACARS panel"]').trigger('click');
		expect(wrapper.vm.vfos[0].acars).toBe(true);
	});
	it('uses normal tuning for the selected VFO without changing audio mode', async () => {
		wrapper = mount(ReceiverView);
		const tune = vi.spyOn(wrapper.vm, 'validateAndApplyVfoFreq').mockImplementation(() => {});
		await wrapper.setData({
			vfos: [makeDefaultVfo(100), makeDefaultVfo(131.55)],
			activeVfoIndex: 1,
			acars: { panelOpen: true, sources: [], status: [] },
		});
		await wrapper.get('select[aria-label="ACARS channel"]').setValue('131.725');
		await wrapper
			.findAll('.acars-panel button')
			.find((button) => button.text() === 'Tune ACARS channel')!
			.trigger('click');
		expect(tune).toHaveBeenCalledWith(1, 131.725);
		expect(wrapper.vm.vfos[1].mode).toBe('wfm');
	});
	it('searches and shows message details as text, rejecting stale data and hiding messages after retuning', async () => {
		wrapper = mount(ReceiverView);
		await wrapper.setData({
			running: true,
			vfos: [{ ...makeDefaultVfo(131.55), acars: true }],
			acars: { panelOpen: true, sources: [], status: [] },
		});
		wrapper.vm._onAcarsMessage(0, 131.55, message());
		await nextTick();
		expect(wrapper.get('.acars-panel tbody').text()).toContain('ANZ001');
		await wrapper.get('input[aria-label="Search ACARS messages"]').setValue('gate');
		expect(wrapper.findAll('.acars-panel tbody tr')).toHaveLength(1);
		await wrapper.get('.acars-panel tbody button').trigger('click');
		expect(wrapper.get('[aria-label="ACARS message details"]').text()).toContain('M01A');
		expect(wrapper.get('.acars-message-text').text()).toContain('<script>test</script>');
		expect(wrapper.find('.acars-panel script').exists()).toBe(false);
		wrapper.vm._onAcarsMessage(0, 131.725, { ...message(), messages: [] });
		await nextTick();
		expect(wrapper.find('.acars-message-text').exists()).toBe(true);
		wrapper.vm.vfos[0].freq = 131.725;
		await nextTick();
		expect(wrapper.find('.acars-message-text').exists()).toBe(false);
		expect(wrapper.find('.acars-panel tbody').exists()).toBe(false);
	});
	it('keeps telemetry out of receiver and VFO control renders', async () => {
		let receiverUpdates = 0;
		let vfoUpdates = 0;
		wrapper = mount(ReceiverView, {
			global: {
				mixins: [
					{
						updated(this: ComponentPublicInstance) {
							if (this === wrapper.vm) receiverUpdates++;
							if (this.$options.name === 'VfoPanel') vfoUpdates++;
						},
					},
				],
			},
		});
		await wrapper.setData({
			running: true,
			vfos: [{ ...makeDefaultVfo(131.55), acars: true }],
			acars: { panelOpen: true, sources: [], status: [] },
		});
		receiverUpdates = vfoUpdates = 0;
		for (let i = 0; i < 10; i++) {
			wrapper.vm._onAcarsMessage(0, 131.55, message());
			await nextTick();
		}
		expect(wrapper.get('.acars-panel tbody').text()).toContain('ZK-NZE');
		expect(receiverUpdates).toBe(0);
		expect(vfoUpdates).toBe(0);
	});
	it('searches decoded airport names and displays readable fields alongside the original report', async () => {
		wrapper = mount(ReceiverView);
		await wrapper.setData({
			running: true,
			vfos: [{ ...makeDefaultVfo(131.55), acars: true }],
			acars: { panelOpen: true, sources: [], status: [] },
		});
		const update = message();
		const raw = 'OFF090746,NZAA,ZBAA,190700,*,LT,0800,090736';
		Object.assign(update.messages[0], { label: '10', text: raw, receivedAt: Date.parse('2026-10-09T07:50:00Z') });
		wrapper.vm._onAcarsMessage(0, 131.55, update);
		await nextTick();
		expect(wrapper.get('.acars-preview strong').text()).toBe('Wheels-off report');
		await wrapper.get('input[aria-label="Search ACARS messages"]').setValue('Auckland');
		expect(wrapper.findAll('.acars-panel tbody tr')).toHaveLength(1);
		await wrapper.get('.acars-panel tbody button').trigger('click');
		const interpretation = wrapper.get('[aria-label="Message interpretation"]');
		expect(interpretation.text()).toContain('Partially decoded');
		expect(interpretation.text()).toContain('2026-10-09 07:46:00 UTC');
		expect(interpretation.text()).toContain('Beijing Capital International Airport');
		expect(interpretation.findAll('dl > div')).toHaveLength(5);
		expect(wrapper.get('.acars-message-text').text()).toBe(raw);
	});
	it('renders verified ARINC fields and a decoded CPDLC phrase beside the original payload', async () => {
		wrapper = mount(ReceiverView);
		await wrapper.setData({
			running: true,
			vfos: [{ ...makeDefaultVfo(131.55), acars: true }],
			acars: { panelOpen: true, sources: [], status: [] },
		});
		const update = message();
		const raw = '- #MD/AA AKLCDYA.CR1.NZ7013209F14E8E75AB53C06BF';
		Object.assign(update.messages[0], { direction: 'uplink', flight: undefined, registration: 'NZ7013', text: raw });
		wrapper.vm._onAcarsMessage(0, 131.55, update);
		await nextTick();
		await wrapper.get('input[aria-label="Search ACARS messages"]').setValue('CPDLC');
		expect(wrapper.findAll('.acars-panel tbody tr')).toHaveLength(1);
		await wrapper.get('.acars-panel tbody button').trigger('click');
		expect(wrapper.get('[aria-label="Message interpretation"]').text()).toContain('CPDLC connection request');
		expect(wrapper.get('[aria-label="Message interpretation"]').text()).toContain('06BF · Verified');
		expect(wrapper.get('[aria-label="Message interpretation"]').text()).toContain('NZZO Label A');
		expect(wrapper.get('.acars-message-text').text()).toBe(raw);
	});
	it('shows the received label-3L position and UTC minute alongside the raw payload', async () => {
		wrapper = mount(ReceiverView);
		await wrapper.setData({
			running: true,
			vfos: [{ ...makeDefaultVfo(131.55), acars: true }],
			acars: { panelOpen: true, sources: [], status: [] },
		});
		const update = message();
		const raw = 'S 37.306/E174.100 /UTC 0809';
		Object.assign(update.messages[0], { label: '3L', text: raw, receivedAt: Date.parse('2026-10-09T08:09:27Z') });
		wrapper.vm._onAcarsMessage(0, 131.55, update);
		await nextTick();
		expect(wrapper.get('.acars-preview strong').text()).toBe('Position report');
		await wrapper.get('input[aria-label="Search ACARS messages"]').setValue('position');
		await wrapper.get('.acars-panel tbody button').trigger('click');
		const interpretation = wrapper.get('[aria-label="Message interpretation"]');
		expect(interpretation.text()).toContain('Decoded format');
		expect(interpretation.text()).toContain('37.306° S (-37.306°)');
		expect(interpretation.text()).toContain('174.100° E (174.100°)');
		expect(interpretation.text()).toContain('2026-10-09 08:09 UTC');
		expect(wrapper.get('.acars-message-text').text()).toBe(raw);
	});
	it.each([
		['1L', 'WX RCVD TXOPS NORMALETA MEL 1130', 'Operations message', '11:30 · timezone unspecified'],
		[
			'2L',
			'DAT 09OCT26 UTC 0810 REG VHX3B FLT JST241 GWT 0 ZFW 595 FOB    87 CAP 129668 FO  435525 LOG 502304 LDR 0 DRT 0753',
			'Flight/load report',
			'Fuel on board (FOB, raw)',
		],
		[
			'H1',
			'#DFBA320,011130,1,1,TB000000/REP004,00,00,1/CCVH-X3B,OCT09,081050,NZAA,NZCH,0241/C0TIA05JST130000/',
			'A320 aircraft report 004',
			'NZCH · Christchurch International Airport',
		],
		[
			'H1',
			'#DFBA380000047,1,1,TB000000;REP020,01;H0102001400000005.A6-EVQ10091026082944070;H02NZAA OMDBUAE5AM    S0586S0785RTRRV11D09;H03Normal Landing Gear Retraction;A1008292310;A20+0',
			'A380 aircraft report 020',
			'Normal Landing Gear Retraction',
		],
	])('shows readable airline fields and preserves the original %s payload', async (label, raw, title, detail) => {
		wrapper = mount(ReceiverView);
		await wrapper.setData({
			running: true,
			vfos: [{ ...makeDefaultVfo(131.55), acars: true }],
			acars: { panelOpen: true, sources: [], status: [] },
		});
		const update = message();
		Object.assign(update.messages[0], { label, text: raw, receivedAt: Date.parse('2026-10-09T08:11:23Z') });
		wrapper.vm._onAcarsMessage(0, 131.55, update);
		await nextTick();
		expect(wrapper.get('.acars-preview strong').text()).toBe(title);
		await wrapper.get('.acars-panel tbody button').trigger('click');
		const interpretation = wrapper.get('[aria-label="Message interpretation"]');
		expect(interpretation.text()).toContain(detail);
		expect(interpretation.text()).toContain(label === 'H1' ? 'measurements undecoded' : 'Partially decoded');
		expect(wrapper.get('.acars-message-text').text()).toBe(raw);
	});
});
