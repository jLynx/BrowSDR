// FANS position-report layouts from MIT xoolive/datalink.
import type { Bits } from './bits';
import * as values from './cpdlc-values';

export function positionReport(bits: Bits): string {
	const flags = Array.from({ length: 19 }, () => bits.read(1));
	const parts = [`Position ${values.position(bits)}`, values.time(bits), values.altitude(bits)];
	const optional: Array<[string, (bits: Bits) => string]> = [
		['Next fix', values.position],
		['Next ETA', values.time],
		['Following fix', values.position],
		['Destination ETA', values.time],
		['Fuel endurance', endurance],
		['Temperature', temperature],
		['Wind', wind],
		['Turbulence code', (reader) => String(reader.read(2))],
		['Icing code', (reader) => String(reader.read(2))],
		['Speed', values.speed],
		['Ground speed', (reader) => `${(reader.read(6) + 7) * 10} kt`],
		['Vertical change', vertical],
		['Track', values.degrees],
		['Heading', values.degrees],
		['Distance', distance],
		['Supplementary text', (reader) => reader.text(reader.read(8) + 1)],
		['Reported waypoint', values.position],
		['Waypoint time', values.time],
		['Waypoint altitude', values.altitude],
	];
	for (let i = 0; i < flags.length; i++) if (flags[i]) parts.push(`${optional[i][0]}: ${optional[i][1](bits)}`);
	return parts.join(' · ');
}

function endurance(bits: Bits): string {
	return `${bits.read(5)} hours ${bits.constrained(6, 0, 59)} minutes`;
}

function temperature(bits: Bits): string {
	const fahrenheit = bits.read(1);
	return `${bits.read(fahrenheit ? 8 : 7) - (fahrenheit ? 105 : 80)} °${fahrenheit ? 'F' : 'C'}`;
}

function wind(bits: Bits): string {
	const direction = bits.constrained(9, 1, 360);
	const metric = bits.read(1);
	return `${direction}° ${bits.read(metric ? 9 : 8)} ${metric ? 'km/h' : 'kt'}`;
}

function vertical(bits: Bits): string {
	const down = bits.read(1);
	const metric = bits.read(1);
	return `${down ? 'Down' : 'Up'} ${bits.read(metric ? 8 : 6) * (metric ? 10 : 100)} ${metric ? 'm/min' : 'ft/min'}`;
}

function distance(bits: Bits): string {
	const metric = bits.read(1);
	return metric ? `${bits.read(10) + 1} km` : `${bits.read(14) / 10} NM`;
}
