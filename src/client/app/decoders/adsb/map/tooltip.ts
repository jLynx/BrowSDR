import type { Aircraft } from '@/worker/decoders/adsb/types';
import type { AircraftMetadata, AirlineMetadata } from '@/app/decoders/adsb/types';

export function aircraftTooltip(record: Aircraft, metadata?: AircraftMetadata, airline?: AirlineMetadata): HTMLElement {
	const element = document.createElement('div');
	element.className = 'adsb-hover-card';
	const heading = document.createElement('strong');
	heading.textContent = record.callsign || record.icao;
	element.append(heading);
	const rows: Array<[string, string]> = [
		['ICAO', record.icao],
		['Registration', metadata?.registration || '—'],
		['Type', metadata?.type || '—'],
		['Airline', airline?.airline || '—'],
		['Operator', metadata?.operator || '—'],
		['Source', 'ADS-B · radio'],
		['Altitude', record.altitude === undefined ? '—' : `${record.altitude.toLocaleString()} ft (${record.altitudeSource ?? 'unknown'})`],
		['Ground speed', record.speed === undefined ? '—' : `${record.speed} kt`],
		['Track', record.heading === undefined ? '—' : `${Math.round(record.heading)}°`],
		['Vertical rate', record.verticalRate === undefined ? '—' : `${record.verticalRate} ft/min`],
		['Squawk', record.squawk || '—'],
		['Last seen', `${Math.max(0, Math.floor((Date.now() - record.lastSeen) / 1000))}s ago`],
	];
	const list = document.createElement('dl');
	for (const [label, value] of rows) {
		const term = document.createElement('dt');
		term.textContent = label;
		const detail = document.createElement('dd');
		detail.textContent = value;
		list.append(term, detail);
	}
	element.append(list);
	return element;
}
