export type WhisperDevice = 'webgpu' | 'wasm';

type Pipeline = ((audio: Float32Array, options: Record<string, any>) => Promise<any>) & { dispose?: () => Promise<void> };
type CreatePipeline = (task: string, model: string, options: Record<string, any>) => Promise<Pipeline>;
type GPUAccess = { requestAdapter(): Promise<unknown | null> };

/** Prefer a usable GPU, falling back once if loading or inference fails. */
export class WhisperBackend {
	private pipeline?: Pipeline;
	device: WhisperDevice = 'wasm';
	constructor(
		private create: CreatePipeline,
		private model: string,
		private progress: (progress: any) => void,
		private report: (device: WhisperDevice, reason?: string) => void,
	) {}

	async load(gpu?: GPUAccess): Promise<void> {
		let adapter: unknown;
		try { adapter = await gpu?.requestAdapter(); } catch { /* Unavailable GPU: use CPU. */ }
		if (adapter) {
			try {
				await this.initialize('webgpu');
				return;
			} catch {
				await this.initialize('wasm', 'GPU model initialization failed; using CPU.');
				return;
			}
		}
		await this.initialize('wasm', 'WebGPU is unavailable; using CPU.');
	}

	private async initialize(device: WhisperDevice, reason?: string): Promise<void> {
		this.pipeline = await this.create('automatic-speech-recognition', this.model, {
			device,
			// Float32 operations are broadly supported by WebGPU; keep CPU quantized.
			dtype: device === 'webgpu' ? 'fp32' : 'q8',
			progress_callback: this.progress,
		});
		this.device = device;
		this.report(device, reason);
	}

	async transcribe(audio: Float32Array, options: Record<string, any>): Promise<any> {
		if (!this.pipeline) throw new Error('Whisper model is not ready');
		try {
			return await this.pipeline(audio, options);
		} catch (error) {
			if (this.device !== 'webgpu') throw error;
			await this.dispose();
			await this.initialize('wasm', 'GPU transcription failed; using CPU.');
			return await this.pipeline!(audio, options);
		}
	}

	async dispose(): Promise<void> {
		const previous = this.pipeline;
		this.pipeline = undefined;
		try { await previous?.dispose?.(); } catch { /* Device loss may prevent disposal. */ }
	}
}
