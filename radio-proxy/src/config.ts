import dotenv from 'dotenv';

dotenv.config();

const MODE_DEFAULTS: Record<string, { bandwidth: number; deEmphasis: string; lowPass: boolean }> = {
	wfm: { bandwidth: 150000, deEmphasis: '50us', lowPass: true },
	nfm: { bandwidth: 12500, deEmphasis: 'none', lowPass: true },
	am: { bandwidth: 10000, deEmphasis: 'none', lowPass: false },
	usb: { bandwidth: 2800, deEmphasis: 'none', lowPass: false },
	lsb: { bandwidth: 2800, deEmphasis: 'none', lowPass: false },
	dsb: { bandwidth: 4600, deEmphasis: 'none', lowPass: false },
	cw: { bandwidth: 200, deEmphasis: 'none', lowPass: false },
	raw: { bandwidth: 48000, deEmphasis: 'none', lowPass: false },
};

export interface Config {
	hostId: string;
	websdrUrl: string;
	vfo: {
		freq: number;
		mode: string;
		bandwidth: number;
		deEmphasis: string;
		lowPass: boolean;
		volume: number;
		squelchEnabled: boolean;
		squelchLevel: number;
	};
	streamPort: number;
	mp3Bitrate: number;
}

export function loadConfig(): Config {
	const hostId = process.env.WEBSDR_HOST_ID;
	if (!hostId) {
		throw new Error('WEBSDR_HOST_ID is required (5-char share code from BrowSDR)');
	}

	const websdrUrl = process.env.WEBSDR_URL;
	if (!websdrUrl) {
		throw new Error('WEBSDR_URL is required (base URL of the WebSDR)');
	}

	const mode = process.env.VFO_MODE || 'wfm';
	const defaults = MODE_DEFAULTS[mode];
	if (!defaults) {
		throw new Error(`Unknown VFO_MODE: ${mode}. Valid: ${Object.keys(MODE_DEFAULTS).join(', ')}`);
	}

	const freq = parseFloat(process.env.VFO_FREQ || '100.0');
	if (isNaN(freq)) {
		throw new Error('VFO_FREQ must be a number (MHz)');
	}

	const bandwidth = process.env.VFO_BANDWIDTH
		? parseInt(process.env.VFO_BANDWIDTH, 10)
		: defaults.bandwidth;

	const volume = process.env.VFO_VOLUME
		? parseInt(process.env.VFO_VOLUME, 10)
		: 100;

	const squelchEnabled = process.env.VFO_SQUELCH_ENABLED === 'true';
	const squelchLevel = process.env.VFO_SQUELCH_LEVEL
		? parseFloat(process.env.VFO_SQUELCH_LEVEL)
		: -100;

	return {
		hostId,
		websdrUrl: websdrUrl.replace(/\/$/, ''),
		vfo: {
			freq,
			mode,
			bandwidth,
			deEmphasis: defaults.deEmphasis,
			lowPass: defaults.lowPass,
			volume: Math.max(0, Math.min(100, volume)),
			squelchEnabled,
			squelchLevel,
		},
		streamPort: parseInt(process.env.STREAM_PORT || '3000', 10),
		mp3Bitrate: parseInt(process.env.MP3_BITRATE || '128', 10),
	};
}
