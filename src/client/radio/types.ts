export interface GainControl {
	name: string;
	min: number;
	max: number;
	step: number;
	default: number;
	options?: number[];
	labels?: string[];
	type: 'slider' | 'checkbox' | 'select';
}

export interface SdrDeviceInfo {
	name: string;
	serial?: string;
	firmware?: string;
}

export interface RxLevel {
	timestamp: number;
	started: number;
	samples: number;
	rmsDbfs: number;
	peakDbfs: number;
	clippedFraction: number;
}

export interface SdrDevice {
	readonly deviceType: string;
	readonly sampleRates: number[];
	readonly gainControls: GainControl[];
	readonly sampleFormat: 'int8' | 'uint8' | 'int16' | 'float32';

	open(device: USBDevice): Promise<void>;
	close(): Promise<void>;
	getInfo(): Promise<SdrDeviceInfo>;

	setSampleRate(rate: number): Promise<void>;
	setFrequency(freqHz: number): Promise<void>;
	setGain(name: string, value: number): Promise<void>;
	setGains?(gains: Record<string, number>): Promise<void>;
	setBandwidth?(bwHz: number): Promise<void>;
	getRxLevel?(): RxLevel | null;

	startRx(callback: (data: ArrayBufferView) => void): Promise<void>;
	stopRx(): Promise<void>;
}

export interface DeviceCapabilities {
	deviceType: string;
	sampleRates: number[];
	gainControls: GainControl[];
	sampleFormat: 'int8' | 'uint8' | 'int16' | 'float32';
}

export interface SdrDriverEntry {
	type: string;
	name: string;
	filters: USBDeviceFilter[];
	create: () => SdrDevice;
}

export interface DeviceCatalogEntry {
	type: string;
	name: string;
	filters: USBDeviceFilter[];
}

export type HackRFGains = { LNA: number; VGA: number; 'Amp (14dB)'?: number };

export type LimeGains = { LNA: number; TIA: number; PGA: number };
