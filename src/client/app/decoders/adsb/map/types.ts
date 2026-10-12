import type * as Leaflet from 'leaflet';
import type { AircraftMetadata, AirlineMetadata } from '@/app/decoders/adsb/types';

export interface MarkerShape {
	w: number;
	h: number;
	viewBox: string;
	path?: string | string[];
	accent?: string | string[];
	accentMult?: number;
	strokeScale?: number;
	transform?: string;
	svg?: string;
	noAspect?: boolean;
}

export interface MarkerData {
	shapes: Record<string, MarkerShape>;
	TypeDesignatorIcons: Record<string, [string, number]>;
	TypeDescriptionIcons: Record<string, [string, number]>;
	CategoryIcons: Record<string, [string, number]>;
}
export interface AircraftMarker {
	marker: Leaflet.Marker;
	trail: Leaflet.Polyline;
	points: Leaflet.LatLngTuple[];
	positionTime: number;
	iconKey: string;
	databaseType?: string;
	metadata?: AircraftMetadata;
	airline?: AirlineMetadata;
	airlineCallsign?: string;
	metadataChecked?: boolean;
	metadataPending?: boolean;
}
