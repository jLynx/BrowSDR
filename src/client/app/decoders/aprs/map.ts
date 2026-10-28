import type * as Leaflet from 'leaflet';
import type { AprsStation } from '@/worker/decoders/aprs/types';
import { stationIconElement } from './icon';
import { motionText, stationKey } from './stations';
import { symbolInfo } from './symbols';

export class AprsMap {
	private map: Leaflet.Map;
	private markers = new Map<string, Leaflet.Marker>();
	private trails = new Map<string, Leaflet.Polyline>();
	private centered = false;
	constructor(
		private leaflet: typeof Leaflet,
		element: HTMLElement,
		onTileError: () => void,
		private onSelect: (key: string) => void,
	) {
		this.map = leaflet.map(element, { center: [20, 0], zoom: 2, worldCopyJump: true });
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
	update(stations: AprsStation[], selected: string): void {
		const live = new Set(stations.map(stationKey));
		for (const [key, marker] of this.markers)
			if (!live.has(key)) {
				marker.remove();
				this.markers.delete(key);
				this.trails.get(key)?.remove();
				this.trails.delete(key);
			}
		for (const station of stations) this.place(station, selected);
		if (!this.centered && stations.length) {
			this.fit();
			this.centered = true;
		}
	}
	private place(station: AprsStation, selected: string): void {
		const key = stationKey(station);
		const location: Leaflet.LatLngTuple = [station.latitude!, station.longitude!];
		const html = stationIconElement(station, selected === key);
		const icon = this.leaflet.divIcon({ html, className: 'adsb-map-icon', iconSize: [24, 24], iconAnchor: [12, 12] });
		let marker = this.markers.get(key);
		if (!marker) {
			marker = this.leaflet.marker(location, { icon, title: station.id }).addTo(this.map);
			marker.on('click', () => this.onSelect(key));
			this.markers.set(key, marker);
		} else marker.setLatLng(location).setIcon(icon);
		const label = document.createElement('span');
		label.textContent = [station.id, symbolInfo(station.symbol).name, motionText(station)].filter(Boolean).join(' · ');
		marker.unbindTooltip().bindTooltip(label);
		const points: Leaflet.LatLngTuple[] = station.trail.map((point) => [point.latitude, point.longitude]);
		let trail = this.trails.get(key);
		if (!trail) {
			trail = this.leaflet.polyline(points, { color: '#4ade80', weight: 2, opacity: 0.8 }).addTo(this.map);
			this.trails.set(key, trail);
		} else trail.setLatLngs(points);
	}
	focus(key: string): void {
		const marker = this.markers.get(key);
		if (marker) this.map.setView(marker.getLatLng(), Math.max(11, this.map.getZoom()));
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
