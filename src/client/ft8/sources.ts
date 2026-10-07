export interface FT8SourceVfo {
	freq: number;
	mode: string;
	bandwidth: number;
	squelchEnabled: boolean;
	lowPass: boolean;
	highPass: boolean;
}

/** Include the whole 200–3000 Hz USB passband, not just its dial frequency. */
export function ft8SourceUnavailable(vfo: FT8SourceVfo, centerFreq: number, sampleRate: number): string {
	if (vfo.mode !== 'usb') return 'USB required';
	const offset = (vfo.freq - centerFreq) * 1e6;
	if (!Number.isFinite(offset) || offset < -sampleRate / 2 || offset + 3000 > sampleRate / 2) return 'Outside receiver bandwidth';
	return '';
}

export function ft8SourceIndices(source: string, vfos: FT8SourceVfo[], centerFreq: number, sampleRate: number): number[] {
	return vfos.flatMap((vfo, index) => (source === 'all' || source === String(index)) &&
		!ft8SourceUnavailable(vfo, centerFreq, sampleRate) ? [index] : []);
}
