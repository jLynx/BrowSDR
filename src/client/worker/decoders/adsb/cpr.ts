import type { CprFrame } from './types';

const mod = (value: number, divisor: number) => ((value % divisor) + divisor) % divisor;

/** Longitude zones from the airborne Compact Position Reporting definition. */
export function longitudeZones(latitude: number): number {
	const lat = Math.abs(latitude);
	if (lat >= 87) return lat > 87 ? 1 : 2;
	const cosine = Math.cos((lat * Math.PI) / 180);
	return Math.floor((2 * Math.PI) / Math.acos(1 - (1 - Math.cos(Math.PI / 30)) / (cosine * cosine)));
}

/** Global airborne CPR requires a matching even/odd pair within ten seconds. */
export function airbornePosition(even: CprFrame, odd: CprFrame): { latitude: number; longitude: number } | undefined {
	if (even.gnss !== odd.gnss || Math.abs(even.time - odd.time) > 10000) return;
	const scale = 131072;
	const index = Math.floor((59 * even.latitude - 60 * odd.latitude) / scale + 0.5);
	let latEven = 6 * (mod(index, 60) + even.latitude / scale);
	let latOdd = (360 / 59) * (mod(index, 59) + odd.latitude / scale);
	if (latEven >= 270) latEven -= 360;
	if (latOdd >= 270) latOdd -= 360;
	if (Math.abs(latEven) > 90 || Math.abs(latOdd) > 90 || longitudeZones(latEven) !== longitudeZones(latOdd)) return;
	const latest = odd.time > even.time ? odd : even;
	const latitude = latest.odd ? latOdd : latEven;
	const zones = longitudeZones(latitude);
	const longitudeIndex = Math.floor((even.longitude * (zones - 1) - odd.longitude * zones) / scale + 0.5);
	const count = Math.max(1, zones - Number(latest.odd));
	let longitude = (360 / count) * (mod(longitudeIndex, count) + latest.longitude / scale);
	if (longitude >= 180) longitude -= 360;
	return { latitude, longitude };
}
