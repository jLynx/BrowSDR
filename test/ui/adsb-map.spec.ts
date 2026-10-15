import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as leaflet from 'leaflet';
import { AircraftMap } from '@/app/decoders/adsb/map/leaflet';
import type { Aircraft } from '@/worker/decoders/adsb/types';
import { offlineDatabaseAvailable } from '@/app/decoders/adsb/database/offline';

vi.mock('@/app/decoders/adsb/database/offline', () => ({ offlineDatabaseAvailable: vi.fn().mockResolvedValue(false) }));

describe('ADS-B flight trails', () => {
	let element: HTMLElement;
	let map: AircraftMap;
	const svg = leaflet.Browser.svg;
	const record = (time: number, longitude = 4): Aircraft => ({
		icao: '40621D',
		latitude: 52,
		longitude,
		positionTime: time,
		lastSeen: time,
		messages: 1,
	});
	const update = (aircraft: Aircraft[], now: number) => map.update(aircraft, '', vi.fn(), now);
	let setPoints: ReturnType<typeof vi.spyOn<leaflet.Polyline, 'setLatLngs'>>;
	beforeEach(() => {
		vi.mocked(offlineDatabaseAvailable).mockResolvedValue(false);
		// jsdom supports SVG elements but lacks Leaflet's createSVGRect feature probe.
		Object.defineProperty(leaflet.Browser, 'svg', { value: true, configurable: true });
		element = document.createElement('div');
		Object.defineProperties(element, { clientWidth: { value: 800 }, clientHeight: { value: 400 } });
		document.body.append(element);
		setPoints = vi.spyOn(leaflet.Polyline.prototype, 'setLatLngs');
		map = new AircraftMap(leaflet, element, vi.fn(), vi.fn());
	});
	afterEach(() => {
		map.destroy();
		element.remove();
		Object.defineProperty(leaflet.Browser, 'svg', { value: svg, configurable: true });
		vi.restoreAllMocks();
	});
	it('retains the trail through expired and missing positions and resumes it on telemetry return', () => {
		update([record(1000)], 1000);
		update([record(2000, 4.1)], 2000);
		const trail = setPoints.mock.contexts.at(-1)!;
		const path = element.querySelector('path.leaflet-interactive');
		update([record(2000, 4.1)], 32001);
		expect(element.querySelector('.adsb-map-icon')).toBeNull();
		expect(element.querySelector('path.leaflet-interactive')).toBe(path);
		update([{ icao: '40621D', lastSeen: 40000, messages: 3 }], 40000);
		map.focus('40621D');
		update([record(45000, 4.2)], 45000);
		expect(element.querySelector('.adsb-map-icon')).not.toBeNull();
		expect(setPoints.mock.contexts.at(-1)).toBe(trail);
		expect(trail.getLatLngs()).toEqual([leaflet.latLng(52, 4), leaflet.latLng(52, 4.1), leaflet.latLng(52, 4.2)]);
	});
	it('keeps points when moving, zooming, resizing and receiving repeated snapshots', () => {
		update([record(1000)], 1000);
		update([record(2000, 4.1)], 2000);
		const trail = setPoints.mock.contexts.at(-1)!;
		const points = [...trail.getLatLngs()];
		map.focus('40621D');
		map.fit();
		map.resize();
		update([record(2000, 4.1)], 3000);
		expect(trail.getLatLngs()).toEqual(points);
		expect(element.querySelector('path.leaflet-interactive')?.getAttribute('d')).toContain('L');
	});
	it('removes expired aircraft trails and bounds retained positions to 60', () => {
		for (let time = 1; time <= 65; time++) update([record(time, 4 + time / 100)], time);
		const trail = setPoints.mock.contexts.at(-1)!;
		expect(trail.getLatLngs()).toHaveLength(60);
		update([], 120066);
		expect(element.querySelector('path.leaflet-interactive')).toBeNull();
		update([record(121000, 5)], 121000);
		expect(setPoints.mock.contexts.at(-1)).not.toBe(trail);
		expect(setPoints.mock.contexts.at(-1)!.getLatLngs()).toEqual([leaflet.latLng(52, 5)]);
	});
});

describe('ADS-B map tile requests', () => {
	it('creates anonymous CORS images for production COEP and reports unavailable tiles', () => {
		const element = document.createElement('div');
		Object.defineProperties(element, {
			clientWidth: { value: 800 },
			clientHeight: { value: 400 },
		});
		document.body.append(element);
		const onTileError = vi.fn();
		const map = new AircraftMap(leaflet, element, onTileError, vi.fn());
		try {
			const tiles = [...element.querySelectorAll<HTMLImageElement>('img.leaflet-tile')];
			expect(tiles.length).toBeGreaterThanOrEqual(3);
			for (const tile of tiles) {
				expect(tile.crossOrigin).toBe('anonymous');
				expect(tile.src).toMatch(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
			}
			tiles[0].dispatchEvent(new Event('error'));
			tiles[1].dispatchEvent(new Event('error'));
			expect(onTileError).not.toHaveBeenCalled();
			tiles[2].dispatchEvent(new Event('error'));
			expect(onTileError).toHaveBeenCalledOnce();
		} finally {
			map.destroy();
			element.remove();
		}
	});
});
