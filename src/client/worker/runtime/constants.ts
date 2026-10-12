/** IF sample rates per demodulation mode. */
export const IF_RATES: Record<string, number> = {
	nfm: 50000,
	wfm: 250000,
	am: 15000,
	usb: 24000,
	lsb: 24000,
	dsb: 24000,
	cw: 3000,
	raw: 48000,
	dsd: 48000,
};

export const AUDIO_RATE = 48000;
