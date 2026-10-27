import { describe, expect, it, vi } from 'vitest';
import type * as Leaflet from 'leaflet';
import { BaseMap } from '@/app/decoders/rtk/map';
import { validBasePosition } from '@/app/decoders/rtk/station-details';
import type { RtcmReference } from '@/worker/decoders/rtk/types';

const reference: RtcmReference = { stationId: 1, itrf: 0, latitude: 0, longitude: 0, heightM: 1, ecef: [1, 2, 3] };

describe('RTK base location map', () => {
	it('keeps pan/zoom during updates, recentres on another base, and safely labels the marker', () => {
		const map = { setView: vi.fn(), invalidateSize: vi.fn(), remove: vi.fn() };
		const marker = { addTo: vi.fn().mockReturnThis(), setLatLng: vi.fn(), unbindTooltip: vi.fn().mockReturnThis(), bindTooltip: vi.fn() };
		const layer = { addTo: vi.fn().mockReturnThis(), on: vi.fn() };
		const leaflet = { map: vi.fn(() => map), circleMarker: vi.fn(() => marker), tileLayer: vi.fn(() => layer) };
		const onError = vi.fn();
		const view = new BaseMap(leaflet as unknown as typeof Leaflet, document.createElement('div'), onError);
		expect(leaflet.tileLayer).toHaveBeenCalledWith(
			expect.stringContaining('openstreetmap.org'),
			expect.objectContaining({ crossOrigin: 'anonymous' }),
		);
		expect(layer.on).toHaveBeenCalledWith('tileerror', onError);
		view.update(reference, 'base-a', '<img src=x onerror=alert(1)>');
		const tooltip = marker.bindTooltip.mock.calls[0][0] as HTMLElement;
		expect(tooltip.children).toHaveLength(0);
		expect(tooltip.textContent).toContain('<img');
		view.update({ ...reference, latitude: 1 }, 'base-a', 'UM960');
		expect(map.setView).toHaveBeenCalledTimes(1);
		expect(marker.setLatLng).toHaveBeenLastCalledWith([1, 0]);
		view.update(reference, 'base-b', 'UM960');
		expect(map.setView).toHaveBeenCalledTimes(2);
		view.resize();
		view.destroy();
		expect(map.invalidateSize).toHaveBeenCalledOnce();
		expect(map.remove).toHaveBeenCalledOnce();
	});

	it('rejects absent, nonfinite and out-of-range coordinates', () => {
		expect(validBasePosition(reference)).toBe(true);
		expect(validBasePosition(undefined)).toBe(false);
		for (const latitude of [NaN, Infinity, -91, 91]) expect(validBasePosition({ ...reference, latitude })).toBe(false);
		expect(validBasePosition({ ...reference, longitude: 181 })).toBe(false);
	});
});
