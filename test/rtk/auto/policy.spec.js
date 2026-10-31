import { describe, expect, it } from 'vitest';
import { RtkAutoDetection, hopPlanAvailability } from '@/worker/decoders/rtk/receiver/policy';
import { mockRtk3Beacon, mockRtk3Packet, mockRtk3Container } from '../../fixtures/rtk/mock-rtk3';
import { mockRtk2Compact, mockRtk2Packet } from '../../fixtures/rtk/mock-rtk2';

const observation = (packet, time = 1.010368, frequencyHz = 915401000, profile = 'rtk3') => ({ packet, time, frequencyHz, profile });
const acquire = (policy) => {
	policy.observe(observation(mockRtk3Beacon()));
	policy.observe(observation(mockRtk3Packet(mockRtk3Container()), 1.1));
	policy.startProbe(policy.pending);
};

describe('automatic RTK evidence', () => {
	it('requires two verified frames from the same header identity', () => {
		const policy = new RtkAutoDetection();
		const bad = mockRtk3Beacon();
		bad.data[0] ^= 1;
		policy.observe(observation(bad));
		policy.observe(observation(mockRtk3Packet(mockRtk3Container(), 4242, 100)));
		policy.observe(observation(mockRtk3Packet(mockRtk3Container(), 4242, 101), 1.1));
		expect(policy.profile).toBeUndefined();
		policy.observe(observation(mockRtk3Beacon(4242, 101, 100), 1.2));
		expect(policy.profile).toBe('rtk3');
		expect(policy.source).toBe('rtk3-100-4242');
	});
	it('waits for the chosen source rather than acquiring another nearby base', () => {
		const policy = new RtkAutoDetection('rtk3-100-4242');
		for (let time = 1; time < 3; time++) policy.observe(observation(mockRtk3Beacon(), time));
		expect(policy.profile).toBeUndefined();
		for (let time = 3; time < 5; time++) policy.observe(observation(mockRtk3Beacon(4242, 100, 100), time));
		expect(policy.source).toBe('rtk3-100-4242');
	});
	it('confirms hops only with same-base beacons at the expected frequency and sample time', () => {
		const policy = new RtkAutoDetection();
		acquire(policy);
		policy.observe(observation(mockRtk3Beacon(4243), 1.610368, 915901000));
		policy.observe(observation(mockRtk3Beacon(), 1.610368, 915401000));
		policy.observe(observation(mockRtk3Beacon(), 1.9, 915901000));
		expect(policy.decision).toBe('checking');
		policy.observe(observation(mockRtk3Beacon(), 1.610368, 915901000));
		expect(policy.decision).toBe('following');
	});
	it('returns to fixed reception after an unsuccessful probe and an IQ gap clears pending evidence', () => {
		const policy = new RtkAutoDetection();
		acquire(policy);
		expect(policy.advance(3)).toBe(false);
		expect(policy.advance(4)).toBe(true);
		expect(policy.decision).toBe('unconfirmed');
		policy.observe(observation(mockRtk3Beacon(), 5));
		expect(policy.pending).toBeUndefined();
		const detecting = new RtkAutoDetection();
		detecting.observe(observation(mockRtk3Packet(mockRtk3Container())));
		detecting.discontinuity();
		detecting.observe(observation(mockRtk3Packet(mockRtk3Container()), 2));
		expect(detecting.profile).toBeUndefined();
	});
	it('distinguishes compact hopping beacons from the legacy RTK2 container format', () => {
		const compact = new RtkAutoDetection();
		const packet = mockRtk2Compact(new Uint8Array(), 9);
		compact.observe(observation(packet, 1.010368, 921791000, 'rtk2'));
		compact.observe(observation(packet, 2.010368, 921791000, 'rtk2'));
		expect(compact.profile).toBe('rtk2');
		compact.startProbe(compact.pending);
		compact.observe(observation(mockRtk2Compact(new Uint8Array(), 15), 3.010368, 925991000, 'rtk2'));
		expect(compact.decision).toBe('following');
		const legacy = new RtkAutoDetection();
		for (let time = 1; time < 3; time++) legacy.observe(observation(mockRtk2Packet(new Uint8Array()), time, 921791000, 'rtk2'));
		expect(legacy.profile).toBe('rtk2');
		expect(legacy.pending).toBeUndefined();
	});
	it('limits probes to a supported grid and the actual received bandwidth', () => {
		expect(hopPlanAvailability('rtk3', 915401000, 20000000, 923118000)).toBe('available');
		expect(hopPlanAvailability('rtk3', 915401000, 1000000, 915401000)).toBe('band-limited');
		expect(hopPlanAvailability('rtk3', 924600000, 20000000, 923118000)).toBe('unconfirmed');
		expect(hopPlanAvailability('rtk1', 923118000, 20000000, 923118000)).toBe('unconfirmed');
	});
});
