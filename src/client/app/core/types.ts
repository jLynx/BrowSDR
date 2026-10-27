import type { CharsetKey } from '@/worker/decoders/charsets';
import type { PocsagMode } from '@/worker/decoders/types';

export interface Vfo {
	adsb?: boolean;
	ais?: boolean;
	radiosonde?: boolean;
	ble?: boolean;
	acars?: boolean;
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
	/** Selected POCSAG codepage key (vendor/model/codepage); default generic ASCII. */
	pocsagCharset?: CharsetKey;
	/** POCSAG type-detection mode: 'auto' | 'alpha' | 'numeric'; default 'auto'. */
	pocsagMode?: PocsagMode;
	/** Show the runner-up interpretation (auto mode) dimmed; default false. */
	pocsagSecondGuess?: boolean;
	/** Decode GSC (Golay Sequential Code) on this NFM VFO. */
	gsc?: boolean;
	/** When true, a GSC voice page auto-unmutes and opens squelch so the user
	 * hears the announcement, restoring the prior state when it ends. */
	gscAutoListen?: boolean;
	/** Show the runner-up alpha/numeric interpretation (dimmed); default false. */
	gscSecondGuess?: boolean;
	/** Decode FLEX (Motorola FLEX paging) on this NFM VFO. */
	flex?: boolean;
	/** Selected FLEX charset (ASCII default, or Kanji which switches decoding). */
	flexCharset?: CharsetKey;
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
