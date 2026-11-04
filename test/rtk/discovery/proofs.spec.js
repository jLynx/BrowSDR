import { describe, expect, it } from 'vitest';
import { RtkDiscoveryProofs } from '@/worker/decoders/rtk/discovery/proofs';
import { RtkDiscoveryCatalog } from '@/worker/decoders/rtk/discovery/catalog';
import { discoveryInventory } from '@/worker/decoders/rtk/discovery/inventory';
import { verifiedObservation } from '@/worker/decoders/rtk/receiver/policy';
import { mockRtk3Packet, mockRtk3Container, mockRtk3Beacon } from '../../fixtures/rtk/mock-rtk3';

const radio = (time, sequence = 1, frequencyHz = 915401000, address = 4242) =>
	verifiedObservation({
		profile: 'rtk3',
		time,
		frequencyHz,
		packet: mockRtk3Packet(mockRtk3Container(undefined, sequence), address, 100),
	});

describe('RTK identity evidence across continuous activity probes', () => {
	it('confirms distinct transmissions across probes without letting a lookback copy count twice', () => {
		const proofs = new RtkDiscoveryProofs(),
			first = new RtkDiscoveryCatalog(proofs),
			second = new RtkDiscoveryCatalog(proofs);
		first.observe(radio(1));
		first.discontinuity();
		second.observe(radio(1.001, 1, 915451000));
		expect(discoveryInventory([first, second])).toEqual([]);
		expect(second.packets).toBe(0);
		second.observe(radio(1.6, 2, 915901000));
		const stations = discoveryInventory([first, second]);
		expect(stations).toHaveLength(1);
		expect(stations[0].discovery).toMatchObject({ hoppingObserved: true, frequenciesMHz: [915.401, 915.901] });
	});
	it('allows repeated payload bytes in later transmissions and never joins different identities', () => {
		const proofs = new RtkDiscoveryProofs();
		proofs.observe(radio(1));
		proofs.observe(radio(1.6, 1, 915901000, 4243));
		const key = `rtk3:${radio(1).source}`;
		expect(proofs.confirmed(key)).toBe(false);
		proofs.observe(radio(2, 1));
		const catalog = new RtkDiscoveryCatalog(proofs);
		catalog.observe(radio(3));
		expect(catalog.snapshot()).toHaveLength(1);
	});
	it('discards unconfirmed votes on IQ gaps and after the confirmation window', () => {
		const proofs = new RtkDiscoveryProofs(),
			catalog = new RtkDiscoveryCatalog(proofs);
		catalog.observe(radio(1));
		proofs.discontinuity();
		catalog.discontinuity();
		catalog.observe(radio(2, 2));
		expect(catalog.snapshot()).toEqual([]);
		catalog.observe(radio(23, 3));
		expect(catalog.snapshot()).toEqual([]);
		catalog.observe(radio(24, 4));
		expect(catalog.snapshot()).toHaveLength(1);
	});
	it('bounds the shared source inventory', () => {
		const proofs = new RtkDiscoveryProofs(),
			catalog = new RtkDiscoveryCatalog(proofs);
		for (let address = 0; address < 90; address++) {
			catalog.observe(verifiedObservation({ profile: 'rtk3', time: address, frequencyHz: 915401000, packet: mockRtk3Beacon(address) }));
		}
		expect(catalog.snapshot()).toHaveLength(64);
	});
});
