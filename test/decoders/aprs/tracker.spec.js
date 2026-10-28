import { describe, expect, it } from 'vitest';
import { AprsTracker } from '@/worker/decoders/aprs/tracker';
import { ax25Frame } from './fixtures';

const station = (tracker, id, now) => tracker.snapshot(now).stations.find((item) => item.id === id);

describe('APRS station tracking', () => {
	it('tracks positions, trails and path, and counts digipeated repeats once', () => {
		const tracker = new AprsTracker();
		tracker.process(ax25Frame('N0CALL-9', 'APDW16', [], '!4903.50N/07201.75W>088/036Mobile'), 1000);
		tracker.process(ax25Frame('N0CALL-9', 'APDW16', ['DIGI*', 'WIDE2-1'], '!4903.50N/07201.75W>088/036Mobile'), 3000);
		tracker.process(ax25Frame('N0CALL-9', 'APDW16', [], '!4904.50N/07201.75W>'), 40000);
		const result = tracker.snapshot(40000);
		expect(result.packets.map((packet) => packet.duplicate ?? false)).toEqual([false, true, false]);
		expect(station(tracker, 'N0CALL-9', 40000)).toMatchObject({
			type: 'station',
			packets: 2,
			lastSeen: 40000,
			path: '',
			destination: 'APDW16',
			symbol: '/>',
			comment: 'Mobile',
			course: undefined,
			positionTime: 40000,
		});
		expect(station(tracker, 'N0CALL-9', 40000).trail).toHaveLength(2);
		expect(tracker.frames).toBe(3);
	});
	it('keeps objects separate from their owner and marks killed objects', () => {
		const tracker = new AprsTracker();
		tracker.process(ax25Frame('N0CALL', 'APRS', [], ';LEADER   *092345z4903.50N/07201.75W>'), 1000);
		tracker.process(ax25Frame('N0CALL', 'APRS', [], ';LEADER   _092345z4903.50N/07201.75W>'), 2000);
		const { stations } = tracker.snapshot(2000);
		expect(stations.find((item) => item.type === 'object')).toMatchObject({ id: 'LEADER', owner: 'N0CALL', killed: true, packets: 2 });
		expect(stations.find((item) => item.type === 'station')).toMatchObject({ id: 'N0CALL', packets: 2 });
		expect(stations.find((item) => item.type === 'station').latitude).toBeUndefined();
	});
	it('applies status, weather, telemetry and the station’s own telemetry definitions', () => {
		const tracker = new AprsTracker();
		tracker.process(ax25Frame('N0QBF-11', 'APRS', [], ':N0QBF-11 :PARM.Battery,Temp'), 1000);
		tracker.process(ax25Frame('N0QBF-11', 'APRS', [], ':N0QBF-11 :UNIT.V,C'), 1000);
		tracker.process(ax25Frame('N0QBF-11', 'APRS', [], ':N0QBF-11 :EQNS.0,0.1,0,0,1,-40'), 1000);
		tracker.process(ax25Frame('N0QBF-11', 'APRS', [], 'T#001,125,060'), 2000);
		tracker.process(ax25Frame('N0QBF-11', 'APRS', [], '>On the air'), 3000);
		tracker.process(ax25Frame('N0QBF-11', 'APRS', [], '_10090556c220s004t077'), 4000);
		expect(station(tracker, 'N0QBF-11', 4000)).toMatchObject({
			status: 'On the air',
			statusTime: 3000,
			telemetry: { sequence: '001', analog: [125, 60] },
			telemetryDefinition: {
				names: ['Battery', 'Temp'],
				units: ['V', 'C'],
				equations: [
					[0, 0.1, 0],
					[0, 1, -40],
				],
			},
			weather: { windDirection: 220, temperature: 25 },
			weatherTime: 4000,
			packets: 6,
		});
	});
	it('logs non-APRS AX.25 frames, rejects invalid headers and bounds history', () => {
		const tracker = new AprsTracker();
		expect(tracker.process(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]))).toBe(false);
		for (let index = 0; index < 205; index++) tracker.process(ax25Frame('N0CALL', 'APRS', [], `>status ${index}`), index * 31000);
		const result = tracker.snapshot(205 * 31000);
		expect(result.packets).toHaveLength(200);
		expect(result.packets[0].status).toBe('status 5');
		expect(tracker.snapshot(205 * 31000 + 3600001).stations).toEqual([]);
		tracker.process(ax25Frame('N0CALL', 'BBS', [], 'connect', { control: 0x3f, pid: null }), 0);
		expect(tracker.snapshot(0).packets.at(-1)).toMatchObject({ kind: 'ax25', info: 'connect' });
	});
});
