export const HD_IQ_RATE = 744187.5;
export const HD_BANDWIDTH = 400000;

export interface HdProgram {
	program: number;
	type?: number;
	restricted?: boolean;
	title: string;
	artist: string;
	album: string;
	genre: string;
}

export interface HdStatus {
	state: 'off' | 'loading' | 'searching' | 'locked' | 'error';
	message: string;
	program: number;
	station: string;
	slogan: string;
	stationMessage: string;
	programs: HdProgram[];
	frames: number;
	ber?: number;
	merLower?: number;
	merUpper?: number;
}

export interface HdMessage {
	type: 'hd_radio';
	freq: number;
	status: HdStatus;
}

export interface HdModule {
	HEAPF32: Float32Array;
	_hd_init(): number;
	_hd_process(ptr: number, count: number): number;
	_hd_destroy(): void;
	_hd_reset(): void;
	_malloc(bytes: number): number;
	_free(ptr: number): void;
}

export interface HdOptions {
	locateFile(path: string): string;
	onNumbers(type: number, program: number, a: number, b: number): void;
	onText(type: number, program: number, a: string, b: string, c: string, d: string): void;
	onAudio(program: number, samples: Int16Array, flags: number): void;
	print(text: string): void;
	printErr(text: string): void;
}

export type HdFactory = (options: HdOptions) => Promise<HdModule>;

export function hdProgram(value: unknown): number {
	return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 7 ? Number(value) : 0;
}

export function emptyHdStatus(program = 0): HdStatus {
	return { state: 'off', message: 'Decoder off', program, station: '', slogan: '', stationMessage: '', programs: [], frames: 0 };
}

export function hdAudioChanged(
	previous: { mode?: string; freq?: number; hdProgram?: number },
	next: { mode?: string; freq?: number; hdProgram?: number },
): boolean {
	return (
		(previous.mode === 'hdradio' || next.mode === 'hdradio') &&
		(previous.mode !== next.mode || previous.freq !== next.freq || hdProgram(previous.hdProgram) !== hdProgram(next.hdProgram))
	);
}
