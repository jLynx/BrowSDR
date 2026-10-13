import type { Radiosonde } from './types';
import type { Rs41Calibration } from './calibration';

function polynomial(coefficients: number[], x: number): number {
	return coefficients.reduceRight((sum, coefficient) => sum * x + coefficient, 0);
}

function temperature(cal: Rs41Calibration, ratio: number, coefficients: number, scale: number): number {
	const resistance = cal.float(61) + (cal.float(65) - cal.float(61)) * ratio;
	const uncalibrated = polynomial(cal.floats(coefficients, 3), resistance * cal.float(scale));
	return uncalibrated + polynomial(cal.floats(scale + 4, 6), uncalibrated);
}

/** Standard-atmosphere pressure for humidity compensation, explicitly estimated. */
export function altitudePressure(altitude: number): number {
	const [height, pressure, kelvin, lapse] =
		altitude > 32000
			? [32000, 8.6802, 228.65, 0.0028]
			: altitude > 20000
				? [20000, 54.7489, 216.65, 0.001]
				: altitude > 11000
					? [11000, 226.321, 216.65, 0]
					: [0, 1013.25, 288.15, -0.0065];
	const g = (9.80665 * 0.0289644) / 8.31446;
	return lapse
		? pressure * (1 + (lapse * (altitude - height)) / kelvin) ** (-g / lapse)
		: pressure * Math.exp((-g * (altitude - height)) / kelvin);
}

function saturation(celsius: number): number {
	const t = celsius + 273.15;
	return Math.exp(-5800.2206 / t + 1.3914993 + 6.5459673 * Math.log(t) - 0.048640239 * t + 0.000041764768 * t ** 2 - 1.4452093e-8 * t ** 3);
}

function pressure(cal: Rs41Calibration, ratio: number, sensorTemperature: number): number {
	const matrix = cal.floats(606, 18);
	const x = matrix[6] / ratio;
	const coefficients = [
		polynomial([matrix[0], matrix[7], matrix[11], matrix[15]], sensorTemperature),
		polynomial([matrix[1], matrix[8], matrix[12], matrix[16]], sensorTemperature),
		polynomial([matrix[2], matrix[9], matrix[13], matrix[17]], sensorTemperature),
		polynomial([matrix[3], matrix[10], matrix[14]], sensorTemperature),
		matrix[4],
		matrix[5],
	];
	return polynomial(coefficients, x);
}

function humidity(cal: Rs41Calibration, ratio: number, air: number, sensor: number, p: number): number {
	const cap = cal.float(69) + (cal.float(73) - cal.float(69)) * ratio;
	let cp = (cap / cal.float(117) - 1) * cal.float(121);
	const t = (sensor - 20) / 180;
	let correction = 0;
	for (let index = 0; index < 3; index++) {
		const coefficient = cal.float(678 + index * 4);
		correction +=
			polynomial(cal.floats(698 + index * 16, 4), t) *
			((coefficient * p) / (1 + coefficient * p) - (coefficient * cp ** index) / (1 + coefficient));
	}
	cp -= correction;
	let rh = 0;
	for (let index = 0; index < 7; index++) rh += cp ** index * polynomial(cal.floats(125 + index * 24, 6), t);
	return (rh * saturation(sensor)) / saturation(air);
}

/** Interpret calibrated sensor counts; missing calibration never becomes zero weather. */
export function decodeWeather(data: Uint8Array, cal: Rs41Calibration, altitude?: number): Partial<Radiosonde> {
	const result: Partial<Radiosonde> = {};
	const count = (offset: number) => data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
	const ratio = (offset: number) => (count(offset) - count(offset + 3)) / (count(offset + 6) - count(offset + 3));
	result.measurements = Array.from({ length: data.length === 42 ? 12 : 9 }, (_, index) => count(index * 3));
	if (altitude !== undefined) result.estimatedPressure = altitudePressure(altitude);
	if (cal.has(61, 56)) {
		const value = temperature(cal, ratio(0), 77, 89);
		if (Number.isFinite(value) && value > -120 && value < 80) result.temperature = value;
	}
	if (cal.has(61, 8) && cal.has(293, 52)) {
		const value = temperature(cal, ratio(18), 293, 305);
		if (Number.isFinite(value) && value > -120 && value < 120) result.humiditySensorTemperature = value;
	}
	if (data.length === 42 && ratio(27) !== 0 && cal.has(606, 72)) {
		const sensorTemperature = new DataView(data.buffer, data.byteOffset, data.byteLength).getInt16(38, true) / 100;
		const value = pressure(cal, ratio(27), sensorTemperature);
		if (Number.isFinite(value) && value > 0 && value < 1200) {
			result.pressure = value;
			result.pressureSensorTemperature = sensorTemperature;
		}
	}
	Object.assign(result, humidityResult(result, cal, ratio(9)));
	return result;
}

function humidityResult(result: Partial<Radiosonde>, cal: Rs41Calibration, sensorRatio: number): Partial<Radiosonde> {
	const weather: Partial<Radiosonde> = {};
	if (
		result.temperature !== undefined &&
		result.humiditySensorTemperature !== undefined &&
		cal.has(69, 224) &&
		cal.has(678, 12) &&
		cal.has(698, 48) &&
		(result.pressure ?? result.estimatedPressure) !== undefined
	) {
		const value = humidity(
			cal,
			sensorRatio,
			result.temperature,
			result.humiditySensorTemperature,
			(result.pressure ?? result.estimatedPressure!) / 1000,
		);
		if (Number.isFinite(value)) {
			weather.humidity = Math.max(0, Math.min(100, value));
			if (weather.humidity > 0) {
				const t = result.temperature;
				const gamma = Math.log(weather.humidity / 100) + (17.625 * t) / (243.04 + t);
				weather.dewPoint = (243.04 * gamma) / (17.625 - gamma);
			}
		}
	}
	return weather;
}
