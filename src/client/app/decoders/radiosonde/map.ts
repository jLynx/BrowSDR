import type * as Leaflet from 'leaflet';
import type { Radiosonde } from '@/worker/decoders/radiosonde/types';
import { sondeIconElement } from './icon';

export class SondeMap {
	private map: Leaflet.Map;
	private markers = new Map<string, Leaflet.Marker>();
	private trails = new Map<string, Leaflet.Polyline>();
	private centered = false;
	constructor(
		private leaflet: typeof Leaflet,
		element: HTMLElement,
		onTileError: () => void,
		private onSelect: (id: string) => void,
	) {
		this.map = leaflet.map(element, { center: [-41, 174], zoom: 5, worldCopyJump: true });
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
	update(sondes: Radiosonde[], selected: string): void {
		const live = new Set(sondes.map((item) => item.id));
		for (const [id, marker] of this.markers)
			if (!live.has(id)) {
				marker.remove();
				this.markers.delete(id);
				this.trails.get(id)?.remove();
				this.trails.delete(id);
			}
		for (const sonde of sondes) {
			const location: Leaflet.LatLngTuple = [sonde.latitude!, sonde.longitude!];
			const html = sondeIconElement(selected === sonde.id);
			const icon = this.leaflet.divIcon({ html, className: 'adsb-map-icon', iconSize: [30, 36], iconAnchor: [15, 18] });
			let marker = this.markers.get(sonde.id);
			if (!marker) {
				marker = this.leaflet.marker(location, { icon, title: sonde.id }).addTo(this.map);
				marker.on('click', () => this.onSelect(sonde.id));
				this.markers.set(sonde.id, marker);
			} else marker.setLatLng(location).setIcon(icon);
			const label = document.createElement('span');
			label.textContent = `${sonde.id} · ${Math.round(sonde.altitude!)} m · ${sonde.climb?.toFixed(1) ?? '—'} m/s climb`;
			marker.unbindTooltip().bindTooltip(label);
			const points: Leaflet.LatLngTuple[] = sonde.trail.map((point) => [point.latitude, point.longitude]);
			let trail = this.trails.get(sonde.id);
			if (!trail) {
				trail = this.leaflet.polyline(points, { color: '#f59e0b', weight: 3 }).addTo(this.map);
				this.trails.set(sonde.id, trail);
			} else trail.setLatLngs(points);
		}
		if (!this.centered && sondes.length) {
			this.fit();
			this.centered = true;
		}
	}
	focus(id: string): void {
		const marker = this.markers.get(id);
		if (marker) this.map.setView(marker.getLatLng(), Math.max(10, this.map.getZoom()));
	}
	fit(): void {
		const points = [...this.markers.values()].map((marker) => marker.getLatLng());
		if (points.length) this.map.fitBounds(this.leaflet.latLngBounds(points), { padding: [30, 30], maxZoom: 12 });
	}
	resize(): void {
		this.map.invalidateSize();
	}
	destroy(): void {
		this.map.remove();
		this.markers.clear();
		this.trails.clear();
	}
}
