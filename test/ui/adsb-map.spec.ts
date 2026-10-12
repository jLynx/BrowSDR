import { describe, expect, it, vi } from 'vitest';
import * as leaflet from 'leaflet';
import { AircraftMap } from '@/app/decoders/adsb/map/leaflet';

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
