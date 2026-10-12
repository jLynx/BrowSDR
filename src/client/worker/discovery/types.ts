export interface DiscoveryConfig {
	centerHz: number;
	sampleRate: number;
	thresholdDb: number;
	minWidthHz: number;
	excludeDc: boolean;
}

export interface DetectedSignal {
	frequencyHz: number;
	widthHz: number;
	aboveNoiseDb: number;
}

export interface DiscoverySignal extends DetectedSignal {
	id: number;
	firstSeen: number;
	lastSeen: number;
	hits: number;
	observations: number;
	active: boolean;
}

export interface TrackedDiscoverySignal extends DiscoverySignal {
	/** Unsnapped centre used only for matching subsequent FFT detections. */
	estimatedFrequencyHz: number;
}

export interface DiscoveryFrame {
	data: Float32Array;
	config: DiscoveryConfig;
	time: number;
}

export interface DiscoveryResult {
	signals: DiscoverySignal[];
	binHz: number;
	frames: number;
	time: number;
}
