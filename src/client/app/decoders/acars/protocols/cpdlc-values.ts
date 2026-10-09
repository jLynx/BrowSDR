// FANS PER body layouts from MIT xoolive/datalink; units/constraints checked against libacars.
import type { Bits } from './bits';

export function altitude(bits: Bits): string {
	const choice = bits.read(3);
	const widths = [12, 14, 12, 13, 18, 16, 10, 11];
	const minima = [0, 0, 0, 0, 0, 0, 30, 100];
	const maxima = [2500, 16000, 2100, 7000, 150000, 50000, 600, 2000];
	const value = bits.constrained(widths[choice], minima[choice], maxima[choice]);
	if (choice === 6) return `FL${value}`;
	if (choice === 7) return `${value * 10} m (metric flight level)`;
	return `${choice === 0 || choice === 2 ? value * 10 : value} ${choice % 2 ? 'm' : 'ft'} (${['QNH', 'QNH', 'QFE', 'QFE', 'GNSS', 'GNSS'][choice]})`;
}

export function time(bits: Bits): string {
	const hour = bits.constrained(5, 0, 23);
	const minute = bits.constrained(6, 0, 59);
	return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC`;
}

export function speed(bits: Bits): string {
	const choice = bits.read(3);
	const widths = [5, 7, 6, 7, 6, 8, 5, 9];
	const minima = [7, 10, 7, 10, 7, 10, 61, 93];
	const value = bits.read(widths[choice]) + minima[choice];
	if (choice >= 6) return `Mach ${(value / 100).toFixed(2)}`;
	return `${value * 10} ${choice % 2 ? 'km/h' : 'kt'} (${['IAS', 'IAS', 'TAS', 'TAS', 'ground', 'ground'][choice]})`;
}

export function position(bits: Bits): string {
	const choice = bits.read(3);
	if (choice === 0) return bits.text(bits.constrained(3, 1, 5), true);
	if (choice === 1) return bits.text(bits.constrained(2, 1, 4), true);
	if (choice === 2) return bits.text(4, true);
	if (choice !== 3) throw new Error('Unsupported position choice');
	return `${coordinate(bits, true)}°, ${coordinate(bits, false)}°`;
}

function coordinate(bits: Bits, latitude: boolean): string {
	const minutes = bits.read(1);
	const degrees = bits.constrained(latitude ? 7 : 8, 0, latitude ? 90 : 180);
	const tenths = minutes ? bits.constrained(10, 0, 599) : 0;
	if (degrees === (latitude ? 90 : 180) && tenths) throw new Error('Invalid coordinate');
	const sign = bits.read(1) ? -1 : 1;
	return String(Number((sign * (degrees + tenths / 600)).toFixed(6)));
}

export function direction(bits: Bits): string {
	const names = ['left', 'right', 'either side', 'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest'];
	return names[bits.constrained(4, 0, 10)];
}

export function degrees(bits: Bits): string {
	const value = bits.constrained(9, 1, 360);
	return `${value}° ${bits.read(1) ? 'true' : 'magnetic'}`;
}

export function distance(bits: Bits): string {
	const metric = bits.read(1);
	return `${bits.read(metric ? 8 : 7) + 1} ${metric ? 'km' : 'NM'}`;
}

export function beacon(bits: Bits): string {
	return Array.from({ length: 4 }, () => bits.read(3)).join('');
}

export function frequency(bits: Bits): string {
	const choice = bits.read(2);
	if (choice < 3) {
		const value = bits.constrained(choice === 2 ? 18 : 15, [2850, 117000, 225000][choice], [28000, 138000, 399975][choice]);
		return choice === 0 ? `${value} kHz` : `${(value / 1000).toFixed(3)} MHz`;
	}
	let channel = '';
	for (let i = 0; i < 12; i++) {
		const code = bits.constrained(4, 0, 10);
		channel += code === 0 ? ' ' : String(code - 1);
	}
	return `SATCOM channel ${channel.trim()}`;
}

export function unit(bits: Bits): string {
	const name = bits.read(1) ? bits.text(bits.read(4) + 3) : bits.text(4, true);
	return `${name} ${['Center', 'Approach', 'Tower', 'Final', 'Ground', 'Clearance', 'Departure', 'Control'][bits.read(3)]}`;
}

export function procedure(bits: Bits): string {
	const transition = bits.read(1);
	const type = ['arrival', 'approach', 'departure'][bits.constrained(2, 0, 2)];
	const name = bits.text(bits.read(3) + 1, true);
	return `${type} ${name}${transition ? ` transition ${bits.text(bits.read(3) + 1, true)}` : ''}`;
}

export function altimeter(bits: Bits): string {
	return bits.read(1) ? `${bits.constrained(13, 7500, 12500) / 10} hPa` : `${(bits.constrained(10, 2200, 3200) / 100).toFixed(2)} inHg`;
}
