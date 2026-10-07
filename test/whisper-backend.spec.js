import { describe, expect, it, vi } from 'vitest';
import { WhisperBackend } from '../src/client/whisper-backend';

const gpu = { requestAdapter: async () => ({}) };

describe('Whisper GPU selection and CPU recovery', () => {
	it('uses fp16 for large models when the GPU supports it', async () => {
		const create = vi.fn().mockResolvedValue(vi.fn());
		const backend = new WhisperBackend(create, 'onnx-community/whisper-large-v3-turbo', vi.fn(), vi.fn());
		await backend.load({ requestAdapter: async () => ({ features: new Set(['shader-f16']) }) });
		expect(create.mock.calls[0][2]).toMatchObject({ device: 'webgpu', dtype: 'fp16' });
	});
	it('avoids multi-gigabyte fp32 weights on GPUs without fp16', async () => {
		const create = vi.fn().mockResolvedValue(vi.fn());
		const backend = new WhisperBackend(create, 'distil-whisper/distil-large-v3.5-ONNX', vi.fn(), vi.fn());
		await backend.load(gpu);
		expect(create.mock.calls[0][2]).toMatchObject({ device: 'webgpu', dtype: 'q8' });
	});
	it('uses WebGPU when an adapter and model are available', async () => {
		const transcribe = vi.fn().mockResolvedValue({ text: 'Radio check' });
		const create = vi.fn().mockResolvedValue(transcribe);
		const report = vi.fn();
		const backend = new WhisperBackend(create, 'model', vi.fn(), report);
		await backend.load(gpu);
		expect(create.mock.calls[0][2]).toMatchObject({ device: 'webgpu', dtype: 'fp32' });
		expect(report).toHaveBeenCalledWith('webgpu', undefined);
		expect(await backend.transcribe(new Float32Array(16000), {})).toEqual({ text: 'Radio check' });
	});
	it.each([undefined, { requestAdapter: async () => null }, { requestAdapter: async () => { throw new Error('blocked'); } }])('uses CPU when WebGPU cannot provide an adapter (%s)', async access => {
		const create = vi.fn().mockResolvedValue(vi.fn());
		const backend = new WhisperBackend(create, 'model', vi.fn(), vi.fn());
		await backend.load(access);
		expect(create).toHaveBeenCalledTimes(1);
		expect(create.mock.calls[0][2]).toMatchObject({ device: 'wasm', dtype: 'q8' });
	});
	it('falls back when GPU model initialization fails', async () => {
		const create = vi.fn().mockRejectedValueOnce(new Error('GPU session failed')).mockResolvedValueOnce(vi.fn());
		const report = vi.fn();
		const backend = new WhisperBackend(create, 'model', vi.fn(), report);
		await backend.load(gpu);
		expect(backend.device).toBe('wasm');
		expect(report).toHaveBeenCalledWith('wasm', expect.stringContaining('initialization failed'));
	});
	it('retries the same audio on CPU after GPU inference fails and stays on CPU', async () => {
		const accelerated = vi.fn().mockRejectedValue(new Error('device lost'));
		accelerated.dispose = vi.fn();
		const cpu = vi.fn().mockResolvedValue({ text: 'Copy that' });
		const create = vi.fn().mockResolvedValueOnce(accelerated).mockResolvedValueOnce(cpu);
		const backend = new WhisperBackend(create, 'model', vi.fn(), vi.fn());
		await backend.load(gpu);
		const audio = new Float32Array(16000);
		const options = { language: 'en' };
		expect(await backend.transcribe(audio, options)).toEqual({ text: 'Copy that' });
		expect(cpu).toHaveBeenCalledWith(audio, options);
		expect(accelerated.dispose).toHaveBeenCalledOnce();
		await backend.transcribe(audio, options);
		expect(create).toHaveBeenCalledTimes(2);
		expect(accelerated).toHaveBeenCalledOnce();
	});
	it('propagates CPU failures without repeatedly reloading', async () => {
		const cpu = vi.fn().mockRejectedValue(new Error('CPU failed'));
		const create = vi.fn().mockResolvedValue(cpu);
		const backend = new WhisperBackend(create, 'model', vi.fn(), vi.fn());
		await backend.load();
		await expect(backend.transcribe(new Float32Array(10), {})).rejects.toThrow('CPU failed');
		expect(create).toHaveBeenCalledOnce();
	});
});
