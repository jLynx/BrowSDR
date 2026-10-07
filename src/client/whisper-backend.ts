export type WhisperDevice = 'webgpu' | 'wasm';

type Pipeline = ((audio: Float32Array, options: Record<string, any>) => Promise<any>) & { dispose?: () => Promise<void> };
type CreatePipeline = (task: string, model: string, options: Record<string, any>) => Promise<Pipeline>;
type GPUAccess = { requestAdapter(): Promise<{ features?: { has(feature: string): boolean } } | null> };

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
		let adapter: { features?: { has(feature: string): boolean } } | null | undefined;
		try { adapter = await gpu?.requestAdapter(); } catch { /* Unavailable GPU: use CPU. */ }
		if (adapter) {
			try {
				await this.initialize('webgpu', undefined, adapter.features?.has('shader-f16') === true);
				return;
			} catch {
				await this.initialize('wasm', 'GPU model initialization failed; using CPU.');
				return;
			}
		}
		await this.initialize('wasm', 'WebGPU is unavailable; using CPU.');
	}

	private async initialize(device: WhisperDevice, reason?: string, supportsFp16 = false): Promise<void> {
		const largeModel = /(?:large-v3|large-v3\.5)/.test(this.model);
		this.pipeline = await this.create('automatic-speech-recognition', this.model, {
			device,
			// Large fp32 encoders exceed 2 GB. Prefer fp16 when supported,
			// otherwise use q8 rather than allocating the external fp32 weights.
			dtype: device === 'wasm' ? 'q8' : largeModel ? (supportsFp16 ? 'fp16' : 'q8') : 'fp32',
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
