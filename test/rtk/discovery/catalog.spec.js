import { describe, expect, it } from 'vitest';
import { RtkDiscoveryCatalog } from '@/worker/decoders/rtk/discovery/catalog';
import { verifiedObservation } from '@/worker/decoders/rtk/receiver/policy';
import { discoveryInventory } from '@/worker/decoders/rtk/discovery/inventory';
import { mockRtk3Beacon, mockRtk3Packet, mockRtk3Container } from '../../fixtures/rtk/mock-rtk3';
import { mockRtk2Compact } from '../../fixtures/rtk/mock-rtk2';

const radio = (packet, frequencyHz = 915401000, time = 1, profile = 'rtk3') => verifiedObservation({ packet, frequencyHz, time, profile });

describe('RTK discovery inventory', () => {
	it('merges independent scout lanes without joining fragments or losing positions and latest acquisition channels', () => {
		const first = new RtkDiscoveryCatalog(),
			second = new RtkDiscoveryCatalog();
		first.observe(radio(mockRtk3Packet(mockRtk3Container(undefined, 1), 4242, 100)));
		first.observe(radio(mockRtk3Packet(mockRtk3Container(undefined, 2), 4242, 100), 915401000, 2));
		second.observe(radio(mockRtk3Beacon(4242, 100, 100), 921401000, 10));
		second.observe(radio(mockRtk3Beacon(4242, 100, 101), 921401000, 11));
		const merged = discoveryInventory([first, second]);
		expect(merged).toHaveLength(2);
		const station = merged.find((base) => base.addressPrefix === 100);
		expect(station.reference).toBeDefined();
		expect(station.discovery).toMatchObject({ hoppingObserved: true, frequenciesMHz: [915.401, 921.401], latestFrequencyMHz: 921.401 });
		expect(first.flush()).toHaveLength(2);
		expect(second.flush()).toHaveLength(0);
	});
	it('keeps overlapping bases, different generations, and both RTK3 address words separate', () => {
		const catalog = new RtkDiscoveryCatalog();
		catalog.observe(radio(mockRtk3Beacon(4242, 100, 100)));
		catalog.observe(radio(mockRtk3Beacon(4242, 100, 101)));
		catalog.observe(radio(mockRtk2Compact(new Uint8Array(), 0), 915491000, 1, 'rtk2'));
		expect(
			catalog
				.snapshot()
				.map((station) => station.discovery.profile)
				.sort(),
		).toEqual(['rtk2', 'rtk3', 'rtk3']);
		expect(
			catalog
				.snapshot()
				.filter((station) => station.discovery.profile === 'rtk3')
				.map((station) => station.addressPrefix),
		).toEqual([100, 101]);
	});
	it('does not infer hopping from one frequency or repeated frames with carrier drift', () => {
		const catalog = new RtkDiscoveryCatalog();
		catalog.observe(radio(mockRtk3Beacon(), 915401000));
		catalog.observe(radio(mockRtk3Beacon(), 915404000, 2));
		expect(catalog.snapshot()[0].discovery).toMatchObject({ hoppingObserved: false, frequenciesMHz: [915.401] });
		catalog.discontinuity();
		catalog.observe(radio(mockRtk3Beacon(), 921401000, 15));
		expect(catalog.snapshot()).toHaveLength(1);
		expect(catalog.snapshot()[0].discovery).toMatchObject({ hoppingObserved: true, frequenciesMHz: [915.401, 921.401] });
	});
	it('requires two data frames from one source and retains verified corrections across survey visits', () => {
		const catalog = new RtkDiscoveryCatalog();
		catalog.observe(radio(mockRtk3Packet(mockRtk3Container(undefined, 1), 4242, 100)));
		expect(catalog.snapshot()).toEqual([]);
		catalog.observe(radio(mockRtk3Packet(mockRtk3Container(undefined, 2), 4242, 100), 915401000, 2));
		expect(catalog.snapshot()[0]).toMatchObject({ rtcmCount: 2, reference: { latitude: 0, longitude: 0 } });
		catalog.discontinuity();
		catalog.observe(radio(mockRtk3Beacon(4242, 100, 100), 921401000, 16));
		expect(catalog.snapshot()[0].reference).toBeDefined();
		expect(catalog.flush()).toHaveLength(2);
		expect(catalog.flush()).toEqual([]);
	});
	it('bounds inventories and observed channels', () => {
		const catalog = new RtkDiscoveryCatalog();
		for (let address = 0; address < 90; address++) catalog.observe(radio(mockRtk3Beacon(address), 915401000, address));
		expect(catalog.snapshot()).toHaveLength(64);
	});
	it('retains positions and cumulative correction counts when a protocol working set evicts a surveyed source', () => {
		const catalog = new RtkDiscoveryCatalog();
		catalog.observe(radio(mockRtk3Packet(mockRtk3Container(undefined, 1), 4242)));
		catalog.observe(radio(mockRtk3Packet(mockRtk3Container(undefined, 2), 4242), 915401000, 2));
		for (let address = 0; address < 20; address++) catalog.observe(radio(mockRtk3Beacon(address), 915401000, 3 + address));
		catalog.observe(radio(mockRtk3Beacon(4242), 921401000, 24));
		const station = catalog.snapshot().find((station) => station.address === 4242);
		expect(station.rtcmCount).toBe(2);
		expect(station.reference).toBeDefined();
		catalog.observe(radio(mockRtk3Packet(mockRtk3Container(undefined, 3), 4242), 921401000, 25));
		expect(catalog.snapshot().find((station) => station.address === 4242).rtcmCount).toBe(3);
	});
});
