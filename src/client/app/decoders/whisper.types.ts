export interface WhisperState {
	benchmarkAvailable: boolean;
	benchmarkRunning: boolean;
	benchmarkMessage: string;
	benchmarkResult: unknown;
	device: '' | 'webgpu' | 'wasm';
	backendReason: string;
	panelOpen: boolean;
	active: boolean;
	status: string;
	loadProgress: number;
	loadPhase: string;
	loadFile: string;
	loadFilesDone: number;
	loadFilesTotal: number;
	model: string;
	chunkSeconds: number;
	log: WhisperLogEntry[];
	statusMsg: string;
	recording: boolean;
	transcribing: boolean;
	recordStart: Date | null;
	recordDuration: number;
	pendingChunks: number;
}

export interface WhisperVfoState {
	buf: Float32Array[];
	bufLen: number;
	silenceRun: number;
	recording: boolean;
	recordStart: Date | null;
	recordStartFreq: string;
	activitySeen?: boolean;
}

export interface WhisperChunkMeta {
	startTime?: Date | null;
	freq?: string;
	vfoIndex?: number;
	model?: string;
}

export interface WhisperLogEntry {
	time: string;
	freq: string;
	text: string;
	duration: string;
	transcribeTime?: string;
	vfoIndex?: number | null;
	model?: string;
}
