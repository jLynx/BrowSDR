import { describe, expect, it } from 'vitest';
import { visibleStations } from '@/app/decoders/aprs/stations';

const point = (latitude, longitude, time) => ({ latitude, longitude, time });
const base = { id: 'N0CALL-9', type: 'station', packets: 1 };

describe('APRS stations across VFOs', () => {
	// VFO A hears a position at 1000 and a status at 3000; VFO B hears a newer position at 2000.
	const a = {
		...base,
		lastSeen: 3000,
		latitude: 41,
		longitude: -72,
		positionTime: 1000,
		speed: 10,
		comment: 'Mobile',
		status: 'On air',
		statusTime: 3000,
		weather: { temperature: 10 },
		weatherTime: 1500,
		trail: [point(41, -72, 1000)],
	};
	const b = {
		...base,
		lastSeen: 2000,
		latitude: 42,
		longitude: -73,
		positionTime: 2000,
		course: 90,
		weather: { temperature: 5 },
		weatherTime: 500,
		trail: [point(42, -73, 2000)],
	};

	it.each([
		['A first', [[a], [b]]],
		['B first', [[b], [a]]],
	])('merges each report kind by its own timestamp (%s)', (_, sources) => {
		const [merged] = visibleStations(sources, 4000);
		expect(merged).toMatchObject({
			lastSeen: 3000,
			packets: 2,
			latitude: 42,
			longitude: -73,
			positionTime: 2000,
			course: 90,
			status: 'On air',
			statusTime: 3000,
			weather: { temperature: 10 },
			weatherTime: 1500,
			comment: 'Mobile',
		});
		// Motion belongs to the newer position, so A's older speed is not carried over.
		expect(merged.speed).toBeUndefined();
		expect(merged.trail).toEqual([point(41, -72, 1000), point(42, -73, 2000)]);
	});
});
