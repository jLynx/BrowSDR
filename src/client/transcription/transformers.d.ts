declare module 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1' {
	export function pipeline(
		task: string,
		model: string,
		options: {
			device: 'webgpu' | 'wasm';
			dtype: string;
			progress_callback: (event: { status: string; file?: string; progress?: number; total?: number }) => void;
		},
	): Promise<
		((audio: Float32Array, options: Record<string, string | number | boolean>) => Promise<{ text: string }>) & {
			dispose?: () => Promise<void>;
		}
	>;
	export const env: { allowLocalModels: boolean; remoteHost: string };
}
