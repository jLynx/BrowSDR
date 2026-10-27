import type * as Leaflet from 'leaflet';
import type { RtcmReference } from '@/worker/decoders/rtk/types';

export class BaseMap {
	private map: Leaflet.Map;
	private marker?: Leaflet.CircleMarker;
	private key = '';
	private title = '';
	constructor(
		private leaflet: typeof Leaflet,
		element: HTMLElement,
		onTileError: () => void,
	) {
		this.map = leaflet.map(element, { center: [0, 0], zoom: 2, scrollWheelZoom: false });
		leaflet
			.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
				maxZoom: 19,
				crossOrigin: 'anonymous',
				attribution:
					'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
			})
			.addTo(this.map)
			.on('tileerror', onTileError);
	}
	update(reference: RtcmReference, key: string, title: string): void {
		const location: Leaflet.LatLngTuple = [reference.latitude, reference.longitude];
		if (!this.marker)
			this.marker = this.leaflet
				.circleMarker(location, { radius: 7, color: '#fff', weight: 2, fillColor: '#3a86ff', fillOpacity: 1 })
				.addTo(this.map);
		else this.marker.setLatLng(location);
		if (this.title !== title) {
			const label = document.createElement('span');
			label.textContent = title;
			this.marker.unbindTooltip().bindTooltip(label);
			this.title = title;
		}
		if (this.key !== key) {
			this.map.setView(location, 13);
			this.key = key;
		}
	}
	resize(): void {
		this.map.invalidateSize();
	}
	destroy(): void {
		this.map.remove();
	}
}
