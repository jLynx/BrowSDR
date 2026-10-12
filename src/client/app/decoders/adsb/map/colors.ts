// Altitude palette adapted from tar1090 defaults.js (GPL-2.0-or-later).
// Matthias Wirth / FlightAware. See assets/LICENSE and assets/README.md.
const hues = [
	[0, 20],
	[2000, 32.5],
	[4000, 43],
	[6000, 54],
	[8000, 72],
	[9000, 85],
	[11000, 140],
	[40000, 300],
	[51000, 360],
];
const lightness = [
	[0, 53],
	[20, 50],
	[32, 54],
	[40, 52],
	[46, 51],
	[50, 46],
	[60, 43],
	[80, 41],
	[100, 41],
	[120, 41],
	[140, 41],
	[160, 40],
	[180, 40],
	[190, 44],
	[198, 50],
	[200, 58],
	[220, 58],
	[240, 58],
	[255, 55],
	[266, 55],
	[270, 58],
	[280, 58],
	[290, 47],
	[300, 43],
	[310, 48],
	[320, 48],
	[340, 52],
	[360, 53],
];

function interpolate(points: number[][], value: number): number {
	for (let i = points.length - 1; i >= 0; i--) {
		if (value < points[i][0]) continue;
		if (i === points.length - 1) return points[i][1];
		return points[i][1] + ((points[i + 1][1] - points[i][1]) * (value - points[i][0])) / (points[i + 1][0] - points[i][0]);
	}
	return points[0][1];
}

export function aircraftColor(altitude?: number, selected = false, stale = false): string {
	const step = altitude !== undefined && altitude < 8000 ? 50 : 200;
	const rounded = altitude === undefined ? 0 : Math.round(altitude / step) * step;
	const hue = altitude === undefined ? 0 : interpolate(hues, rounded);
	const saturation = Math.min(95, Math.max(0, (altitude === undefined ? 0 : 88) + (selected ? 10 : 0) - (stale ? 35 : 0)));
	const light = Math.min(95, (altitude === undefined ? 75 : interpolate(lightness, hue)) + (selected ? 5 : 0) + (stale ? 9 : 0));
	return `hsl(${hue % 360}, ${saturation}%, ${light}%)`;
}
