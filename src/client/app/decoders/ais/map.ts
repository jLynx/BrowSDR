import type * as Leaflet from 'leaflet';
import type { Vessel } from '@/worker/decoders/ais/types';

export class VesselMap {
	private map: Leaflet.Map;
	private markers = new Map<string, Leaflet.Marker>();
	private centered = false;
	constructor(
		private leaflet: typeof Leaflet,
		element: HTMLElement,
		onTileError: () => void,
		private onSelect: (mmsi: string) => void,
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
	update(vessels: Vessel[], selected: string): void {
		const live = new Set(vessels.map((vessel) => vessel.mmsi));
		for (const [mmsi, marker] of this.markers)
			if (!live.has(mmsi)) {
				marker.remove();
				this.markers.delete(mmsi);
			}
		for (const vessel of vessels) {
			const location: Leaflet.LatLngTuple = [vessel.latitude!, vessel.longitude!];
			const element = document.createElement('span');
			element.className = `ais-vessel-marker${selected === vessel.mmsi ? ' selected' : ''}`;
			element.textContent = '▲';
			element.style.transform = `rotate(${vessel.heading ?? vessel.course ?? 0}deg)`;
			const icon = this.leaflet.divIcon({ html: element, className: 'adsb-map-icon', iconSize: [28, 28], iconAnchor: [14, 14] });
			let marker = this.markers.get(vessel.mmsi);
			if (!marker) {
				marker = this.leaflet.marker(location, { icon, title: vessel.mmsi }).addTo(this.map);
				marker.on('click', () => this.onSelect(vessel.mmsi));
				this.markers.set(vessel.mmsi, marker);
			} else marker.setLatLng(location).setIcon(icon);
			const label = document.createElement('span');
			label.textContent = `${vessel.name || vessel.mmsi} · ${vessel.speed ?? '—'} kt`;
			marker.unbindTooltip().bindTooltip(label);
		}
		if (!this.centered && vessels.length) {
			this.fit();
			this.centered = true;
		}
	}
	focus(mmsi: string): void {
		const marker = this.markers.get(mmsi);
		if (marker) this.map.setView(marker.getLatLng(), Math.max(10, this.map.getZoom()));
	}
	fit(): void {
		const locations = [...this.markers.values()].map((marker) => marker.getLatLng());
		if (locations.length) this.map.fitBounds(this.leaflet.latLngBounds(locations), { padding: [30, 30], maxZoom: 12 });
	}
	resize(): void {
		this.map.invalidateSize();
	}
	destroy(): void {
		this.map.remove();
		this.markers.clear();
	}
}
