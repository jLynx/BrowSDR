export interface ProgressEvent {
	status: string;
	file?: string;
	progress?: number;
	total?: number;
}
export interface LoadingMessage {
	type: 'loading';
	phase: string;
	progress: number;
	file: string;
	filesDone: number;
	filesTotal: number;
}
export type TranscriptionOptions = Record<string, string | number | boolean>;
export type Pipeline = ((audio: Float32Array, options: TranscriptionOptions) => Promise<{ text: string }>) & {
	dispose?: () => Promise<void>;
};
export type CreatePipeline = (
	task: string,
	model: string,
	options: { device: 'webgpu' | 'wasm'; dtype: string; progress_callback: (event: ProgressEvent) => void },
) => Promise<Pipeline>;
export interface BenchmarkResult {
	device: 'wasm' | 'webgpu';
	seconds: number[];
	median: number;
	text: string;
}
export type WhisperMessage =
	| LoadingMessage
	| { type: 'ready'; device: 'wasm' | 'webgpu' }
	| { type: 'backend'; device: 'wasm' | 'webgpu'; reason?: string }
	| { type: 'status' | 'error' | 'benchmark-progress' | 'benchmark-error'; message: string }
	| { type: 'result'; text: string; id: number; audioDuration?: number; transcribeTime: string; model: string }
	| { type: 'discarded'; id: number; reason: string }
	| { type: 'benchmark-result'; audioDuration: number; model: string; results: BenchmarkResult[] };
