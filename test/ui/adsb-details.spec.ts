import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import AdsbDetails from '@/app/decoders/adsb/details';

const aircraft = { icao: 'C827EE', callsign: 'ANZ123', lastSeen: 1000, messages: 1, squawk: '0123', altitude: 12000 };
const record = {
	registration: 'ZK-NNF',
	manufacturer: 'Airbus',
	model: 'A321',
	type: 'L2J',
	owner: 'Example owner',
	operator: 'Example operator',
};

describe('selected aircraft details', () => {
	it('combines live values and metadata without reloading on telemetry updates', async () => {
		const provider = {
			lookupAircraft: vi.fn().mockResolvedValue(record),
			lookupAirline: vi.fn().mockResolvedValue({ airline: 'Air New Zealand', country: 'New Zealand' }),
		};
		const wrapper = mount(AdsbDetails, {
			props: { icao: aircraft.icao, aircraft, now: 2000 },
			global: { provide: { aircraftMetadata: provider } },
		});
		await vi.waitFor(() => expect(wrapper.text()).toContain('ZK-NNF'));
		for (const value of [
			'0123',
			'12,000 ft',
			'Air New Zealand',
			'Airline country',
			'Landplane',
			'Jet',
			'Example owner',
			'Example operator',
		])
			expect(wrapper.text()).toContain(value);
		await wrapper.setProps({ aircraft: { ...aircraft, altitude: 13000 }, now: 3000 });
		expect(wrapper.text()).toContain('13,000 ft');
		expect(provider.lookupAircraft).toHaveBeenCalledOnce();
		expect(provider.lookupAirline).toHaveBeenCalledOnce();
		wrapper.unmount();
	});
	it('ignores late responses for an aircraft that is no longer selected', async () => {
		let finish!: (value: typeof record) => void;
		const provider = {
			lookupAircraft: vi
				.fn()
				.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							finish = resolve;
						}),
				)
				.mockResolvedValue(undefined),
			lookupAirline: vi.fn().mockResolvedValue(undefined),
		};
		const wrapper = mount(AdsbDetails, { props: { icao: aircraft.icao, now: 2000 }, global: { provide: { aircraftMetadata: provider } } });
		await wrapper.setProps({ icao: '123456' });
		finish(record);
		await vi.waitFor(() => expect(wrapper.text()).toContain('No aircraft record'));
		expect(wrapper.text()).not.toContain('ZK-NNF');
		wrapper.unmount();
	});
	it('preserves live data on failure and allows retry', async () => {
		const provider = {
			lookupAircraft: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(record),
			lookupAirline: vi.fn().mockResolvedValue(undefined),
		};
		const wrapper = mount(AdsbDetails, {
			props: { icao: aircraft.icao, aircraft, now: 2000 },
			global: { provide: { aircraftMetadata: provider } },
		});
		await vi.waitFor(() => expect(wrapper.text()).toContain('database unavailable'));
		expect(wrapper.text()).toContain('12,000 ft');
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Retry database lookup')!
			.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('ZK-NNF'));
		wrapper.unmount();
	});
});
