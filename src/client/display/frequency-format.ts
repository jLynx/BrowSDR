export function formatFrequencyMhz(mhz: number): string {
	if (!Number.isFinite(mhz)) return '000.000000';
	const magnitude = Math.abs(mhz).toFixed(6).padStart(10, '0');
	return mhz < 0 ? '-' + magnitude : magnitude;
}

export function formatFrequencyLabel(mhz: number): string {
	return mhz.toFixed(6) + ' MHz';
}
