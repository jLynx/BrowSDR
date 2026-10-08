export interface Vfo {
	rtl433?: boolean;
	rtl433SampleRate?: number;
	rtl433Protocols?: string;
	enabled: boolean;
	freq: number;
	mode: string;
	bandwidth: number;
	snapInterval: number;
	deEmphasis: string;
	squelchEnabled: boolean;
	squelchLevel: number;
	noiseReduction: boolean;
	stereo: boolean;
	lowPass: boolean;
	highPass: boolean;
	rds: boolean;
	rdsRegion: string;
	volume: number;
	pocsag: boolean;
	displayFreq: string;
	focused: boolean;
}

export interface RadioState {
	centerFreq: number;
	frequencyShift: number;
	sampleRate: number;
	fftSize: number;
}

export type GainState = Record<string, number>;

export type LockState = Record<string, boolean>;

export interface Snackbar {
	show: boolean;
	message: string;
}

export interface VfoConflictDialog {
	show: boolean;
	vfoIndex: number;
	requestedFreq: number;
	previousFreq: number;
	optionA: VfoConflictOption;
	optionB: VfoConflictSubsetOption;
}

export type VfoActivityStats = Array<{ count: number; totalMs: number; squelchOpenSince: number | null }>;

export type VfoConflictOption = { centerFreq: number; description: string } | null;

export type VfoConflictSubsetOption = { centerFreq: number; description: string; excludedVfos: number[] } | null;
