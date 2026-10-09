import type * as Leaflet from 'leaflet';
import type { Aircraft } from '@/worker/decoders/adsb/types';
import type { AircraftMetadata } from '@/app/decoders/adsb/types';
import type { AircraftMarker } from './types';
import { aircraftIconElement } from './icons';
import { aircraftColor } from './colors';
import { aircraftTooltip } from './tooltip';
import { lookupOfflineAircraft, lookupOfflineAirline } from '@/app/decoders/adsb/database/lookup';
import { offlineDatabaseAvailable } from '@/app/decoders/adsb/database/offline';

export class AircraftMap {
	private map: Leaflet.Map;
	private markers = new Map<string, AircraftMarker>();
	private centered = false;
	private tiles: Leaflet.TileLayer;
	private tileErrors = 0;
	private offlineReady = false;
	private checkingOffline = false;
	private checkedOfflineAt = 0;
	private metadataQueue: string[] = [];
	private loadingMetadata = false;
	private destroyed = false;
	constructor(
		private leaflet: typeof Leaflet,
		element: HTMLElement,
		onTileError: () => void,
		onSelect: (icao: string) => void,
	) {
		this.map = leaflet.map(element, { center: [20, 0], zoom: 2, worldCopyJump: true });
		this.tiles = leaflet
			.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
				maxZoom: 19,
				// CORS-enabled images satisfy the production page's COEP: require-corp policy.
				crossOrigin: 'anonymous',
				attribution:
					'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
			})
			.addTo(this.map);
		this.tiles.on('tileerror', () => {
			if (++this.tileErrors === 3) onTileError();
		});
		this.map.on('click', () => onSelect(''));
		this.map.on('move zoom resize', () => {
			queueMicrotask(() => {
				if (!this.destroyed) for (const item of this.markers.values()) this.positionTooltip(item.marker);
			});
		});
		const legend = new leaflet.Control({ position: 'bottomright' });
		legend.onAdd = () => {
			const element = document.createElement('div');
			element.className = 'adsb-altitude-legend';
			element.title = 'Aircraft colour by altitude in feet; grey means unknown altitude.';
			const colors = [0, 2000, 4000, 6000, 8000, 11000, 20000, 30000, 40000].map((alt) => aircraftColor(alt)).join(',');
			element.innerHTML = `<span>Altitude (ft)</span><div style="background:linear-gradient(to right,${colors})"></div><small>0 · 2k · 4k · 6k · 8k · 11k · 20k · 30k · 40k+</small>`;
			return element;
		};
		legend.addTo(this.map);
	}

	update(aircraft: Aircraft[], selected: string, onSelect: (icao: string) => void): void {
		this.checkOffline();
		const live = new Set(aircraft.map((item) => item.icao));
		for (const [icao, item] of this.markers) {
			if (!live.has(icao)) {
				item.marker.remove();
				item.trail.remove();
				this.markers.delete(icao);
			}
		}
		for (const record of aircraft) this.updateMarker(record, record.icao === selected, onSelect);
		if (!this.centered && aircraft.length) {
			this.fit();
			this.centered = true;
		}
	}

	fit(): void {
		const points = [...this.markers.values()].map((item) => item.marker.getLatLng());
		if (points.length) this.map.fitBounds(this.leaflet.latLngBounds(points), { padding: [35, 35], maxZoom: 10 });
	}
	focus(icao: string): void {
		const item = this.markers.get(icao);
		if (item) {
			this.map.panTo(item.marker.getLatLng());
			item.marker.openTooltip();
		}
	}
	setAircraftType(icao: string, metadata: AircraftMetadata): void {
		const item = this.markers.get(icao);
		if (item) {
			item.databaseType = metadata.type;
			item.metadata = metadata;
		}
	}
	resize(): void {
		this.map.invalidateSize();
	}
	destroy(): void {
		this.destroyed = true;
		this.metadataQueue = [];
		this.map.remove();
		this.markers.clear();
	}

	private updateMarker(record: Aircraft, selected: boolean, onSelect: (icao: string) => void): void {
		const point: Leaflet.LatLngTuple = [record.latitude!, record.longitude!];
		let item = this.markers.get(record.icao);
		const iconKey = [
			record.category,
			record.altitude,
			record.heading,
			selected,
			item?.databaseType,
			Date.now() - record.positionTime! > 15000,
		].join(':');
		if (!item) {
			const icon = this.icon(record, selected);
			const marker = this.leaflet.marker(point, { icon, title: record.callsign || record.icao, keyboard: true }).addTo(this.map);
			marker.on('click', (event) => {
				this.leaflet.DomEvent.stopPropagation(event);
				onSelect(record.icao);
			});
			marker.on('tooltipopen', () => this.positionTooltip(marker));
			item = {
				marker,
				trail: this.leaflet.polyline([], { color: '#3a86ff', weight: 2, opacity: 0.6 }).addTo(this.map),
				points: [],
				positionTime: 0,
				iconKey,
				airlineCallsign: record.callsign,
			};
			this.markers.set(record.icao, item);
		} else {
			item.marker.setLatLng(point);
			if (item.iconKey !== iconKey) {
				const open = item.marker.isTooltipOpen();
				item.marker.setIcon(this.icon(record, selected, item.databaseType));
				item.iconKey = iconKey;
				if (open) item.marker.openTooltip();
			}
		}
		if (item.airlineCallsign !== record.callsign) {
			item.airlineCallsign = record.callsign;
			item.airline = undefined;
			item.metadataChecked = false;
		}
		if (this.offlineReady && !item.metadataChecked && !item.metadataPending && this.metadataQueue.length < 500) {
			item.metadataPending = true;
			this.metadataQueue.push(record.icao);
			void this.loadMetadata();
		}
		if (item.positionTime !== record.positionTime) {
			if (item.points.length && Math.abs(item.points.at(-1)![1] - point[1]) > 180) item.points = [];
			item.points.push(point);
			if (item.points.length > 60) item.points.shift();
			item.trail.setLatLngs(item.points);
			item.positionTime = record.positionTime!;
		}
		item.trail.setStyle({ color: aircraftColor(record.altitude) });
		const text = aircraftTooltip(record, item.metadata, item.airline);
		if (item.marker.getTooltip()) item.marker.setTooltipContent(text);
		else
			item.marker.bindTooltip(text, {
				direction: 'auto',
				className: 'adsb-aircraft-tooltip',
				offset: [18, 0],
				opacity: 1,
				interactive: true,
			});
		this.positionTooltip(item.marker);
	}
	private positionTooltip(marker: Leaflet.Marker): void {
		if (!marker.isTooltipOpen()) return;
		const element = marker.getTooltip()?.getElement();
		if (!element) return;
		element.style.translate = '';
		const bounds = this.map.getContainer().getBoundingClientRect();
		const card = element.getBoundingClientRect();
		const y = Math.max(bounds.top + 8 - card.top, Math.min(0, bounds.bottom - 8 - card.bottom));
		const leftPadding = card.top + y < bounds.top + 80 ? 48 : 8;
		const x = Math.max(bounds.left + leftPadding - card.left, Math.min(0, bounds.right - 8 - card.right));
		element.style.translate = `${x}px ${y}px`;
	}
	private checkOffline(): void {
		if (this.offlineReady || this.checkingOffline || Date.now() - this.checkedOfflineAt < 10000) return;
		this.checkingOffline = true;
		this.checkedOfflineAt = Date.now();
		void offlineDatabaseAvailable()
			.then((ready) => {
				this.offlineReady = ready;
			})
			.finally(() => {
				this.checkingOffline = false;
			});
	}
	private async loadMetadata(): Promise<void> {
		if (this.loadingMetadata) return;
		this.loadingMetadata = true;
		while (this.metadataQueue.length && !this.destroyed) {
			const icao = this.metadataQueue.shift()!;
			const item = this.markers.get(icao);
			if (!item) continue;
			try {
				item.metadata = await lookupOfflineAircraft(icao);
				item.databaseType = item.metadata?.type;
				const callsign = item.airlineCallsign;
				const airline = callsign ? await lookupOfflineAirline(callsign) : undefined;
				if (callsign === item.airlineCallsign) item.airline = airline;
			} catch {
				// The live category remains usable if browser storage becomes unavailable.
			} finally {
				item.metadataChecked = true;
				item.metadataPending = false;
			}
		}
		this.loadingMetadata = false;
	}
	private icon(record: Aircraft, selected: boolean, databaseType?: string): Leaflet.DivIcon {
		const element = aircraftIconElement(record, selected, databaseType);
		return this.leaflet.divIcon({ html: element, className: 'adsb-map-icon', iconSize: [28, 28], iconAnchor: [14, 14] });
	}
}
