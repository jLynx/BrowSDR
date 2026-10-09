import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	aircraftClassification,
	lookupAircraft,
	lookupOfflineAircraft,
	lookupAirline,
	lookupOfflineAirline,
} from '@/app/decoders/adsb/database/lookup';
import { saveOfflineDatabase, offlineDatabaseAvailable, AIRCRAFT_FORMAT, AIRLINE_FORMAT } from '@/app/decoders/adsb/database/offline';
import { lookupSnapshot, saveSnapshot, snapshotOfflineAvailable } from '@/app/decoders/adsb/database/snapshot';

vi.mock('@/app/decoders/adsb/database/snapshot', () => ({
	lookupSnapshot: vi.fn(),
	snapshotOfflineAvailable: vi.fn(),
	saveSnapshot: vi.fn(),
}));
afterEach(() => {
	vi.resetAllMocks();
	vi.unstubAllGlobals();
});

describe('BrowSDR aircraft database lookups', () => {
	it('uses only the built snapshot for aircraft and airline records', async () => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		vi.mocked(lookupSnapshot).mockResolvedValueOnce(['ZK-NNF', 'Airbus', 'A320', 'L2J', 'Owner', 'Operator']);
		expect(await lookupAircraft('c827ee')).toEqual({
			registration: 'ZK-NNF',
			manufacturer: 'Airbus',
			model: 'A320',
			type: 'L2J',
			owner: 'Owner',
			operator: 'Operator',
		});
		expect(lookupSnapshot).toHaveBeenLastCalledWith('C827EE', AIRCRAFT_FORMAT, false);
		vi.mocked(lookupSnapshot).mockResolvedValueOnce(['Air New Zealand', 'New Zealand']);
		expect(await lookupAirline('ANZ123')).toEqual({ airline: 'Air New Zealand', country: 'New Zealand' });
		expect(lookupSnapshot).toHaveBeenLastCalledWith('ANZ', AIRLINE_FORMAT, false);
		vi.mocked(lookupSnapshot).mockResolvedValue(undefined);
		expect(await lookupAircraft('000001')).toBeUndefined();
		expect(await lookupAirline('ZZZ123')).toBeUndefined();
		expect(fetch).not.toHaveBeenCalled(); // Missing records never start a third-party fallback request.
	});
	it('keeps offline lookups restricted to the cached snapshot and validates identifiers', async () => {
		vi.mocked(lookupSnapshot).mockResolvedValue(undefined);
		await lookupOfflineAircraft('c827ee');
		expect(lookupSnapshot).toHaveBeenLastCalledWith('C827EE', AIRCRAFT_FORMAT, true);
		await lookupOfflineAirline('ANZ123');
		expect(lookupSnapshot).toHaveBeenLastCalledWith('ANZ', AIRLINE_FORMAT, true);
		vi.mocked(lookupSnapshot).mockClear();
		expect(await lookupAircraft('../bad')).toBeUndefined();
		expect(await lookupOfflineAircraft('INVALID')).toBeUndefined();
		expect(await lookupAirline('ZKNNF')).toBeUndefined();
		expect(lookupSnapshot).not.toHaveBeenCalled();
	});
	it('surfaces snapshot failures for retry without attempting another database', async () => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		vi.mocked(lookupSnapshot).mockRejectedValue(new Error('checksum'));
		await expect(lookupAircraft('C827EE')).rejects.toThrow('checksum');
		await expect(lookupAirline('ANZ123')).rejects.toThrow('checksum');
		expect(fetch).not.toHaveBeenCalled();
	});
	it('reports unavailable snapshots and storage failures instead of downloading a fallback', async () => {
		vi.mocked(saveSnapshot).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('quota'));
		await expect(saveOfflineDatabase(() => {})).rejects.toThrow('unavailable');
		await expect(saveOfflineDatabase(() => {})).rejects.toThrow('quota');
		vi.mocked(snapshotOfflineAvailable).mockResolvedValue(true);
		expect(await offlineDatabaseAvailable()).toBe(true);
	});
	it('interprets aircraft classifications without mistaking a type designator for engine data', () => {
		expect(aircraftClassification('L2J')).toEqual({ type: 'Landplane', engines: '2', engineType: 'Jet' });
		expect(aircraftClassification('H1T')).toEqual({ type: 'Helicopter', engines: '1', engineType: 'Turboprop / turboshaft' });
		expect(aircraftClassification('BALL')).toEqual({ type: 'Balloon' });
		expect(aircraftClassification('B738')).toEqual({ type: 'B738' });
		expect(aircraftClassification('')).toEqual({ type: undefined });
	});
});
