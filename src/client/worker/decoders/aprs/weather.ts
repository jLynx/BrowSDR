import type { AprsWeather } from './types';

const MPH = 0.44704;
const HUNDREDTH_INCH = 0.254;
const fahrenheit = (value: number) => ((value - 32) * 5) / 9;

// APRS 1.0.1 chapter 12 weather fields: width and conversion to metric.
const FIELDS: Record<string, [number, keyof AprsWeather, (value: number) => number]> = {
	c: [3, 'windDirection', (value) => value],
	g: [3, 'windGust', (value) => value * MPH],
	t: [3, 'temperature', fahrenheit],
	r: [3, 'rain1h', (value) => value * HUNDREDTH_INCH],
	p: [3, 'rain24h', (value) => value * HUNDREDTH_INCH],
	P: [3, 'rainSinceMidnight', (value) => value * HUNDREDTH_INCH],
	h: [2, 'humidity', (value) => value || 100],
	b: [5, 'pressure', (value) => value / 10],
	L: [3, 'luminosity', (value) => value],
	l: [3, 'luminosity', (value) => value + 1000],
	s: [3, 'snow24h', (value) => value * 25.4],
	'#': [3, 'rain1h', (value) => value],
};

/**
 * Read weather fields until the first unrecognized character; the remainder is the software and unit
 * identifier or free comment. In positionless reports the first `s` is wind speed rather than snowfall.
 */
export function decodeWeather(text: string, weather: AprsWeather = {}, positionless = false): { weather: AprsWeather; rest: string } {
	let offset = 0;
	while (offset < text.length) {
		const name = text[offset];
		const windSpeed = positionless && name === 's' && weather.windSpeed === undefined;
		const field = FIELDS[name];
		if (!field) break;
		const value = text.slice(offset + 1, offset + 1 + field[0]);
		if (value.length < field[0] || !/^(-?\d+|[. ]+)$/.test(value)) break;
		offset += 1 + field[0];
		// Missing sensors are sent as dots or spaces; `#` is an uncalibrated raw rain counter.
		if (/^[. ]+$/.test(value) || name === '#') continue;
		if (windSpeed) weather.windSpeed = Number(value) * MPH;
		else weather[field[1]] = field[2](Number(value));
	}
	return { weather, rest: text.slice(offset) };
}

/** Wind direction and speed from a weather station's `ddd/sss` position extension, in degrees and mph. */
export function windExtension(direction: string, speed: string): AprsWeather {
	const weather: AprsWeather = {};
	if (/^\d{3}$/.test(direction)) weather.windDirection = Number(direction);
	if (/^\d{3}$/.test(speed)) weather.windSpeed = Number(speed) * MPH;
	return weather;
}
