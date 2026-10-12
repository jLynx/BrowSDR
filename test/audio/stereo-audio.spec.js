import { describe, expect, it, vi } from 'vitest';
import { packAudio, unpackAudio, downmix } from '@/audio/pcm';
import { appendPcm } from '@/worker/streams/audio-queue';
import { installWorkerAudioHandler, createAudioBatchers } from '@/worker/streams/local-audio';
import { audioMethods } from '@/app/audio/audio';
import { Backend } from '@/worker/runtime/backend';

function interleave(frames, left, right) {
	const pcm = new Float32Array(frames * 2);
	for (let i = 0; i < frames; i++) {
		pcm[i * 2] = left;
		pcm[i * 2 + 1] = right;
	}
	return pcm;
}
function stream() {
	const backend = new Backend();
	backend.vfoParams = [
		{ enabled: true, volume: 100, freq: 95, mode: 'wfm' },
		{ enabled: true, volume: 100, freq: 96, mode: 'nfm' },
	];
	backend.vfoStates = [0, 1].map(() => ({ audioQueue: new Float32Array(24000), audioQueueLen: 0 }));
	backend._whisperEnabled = true;
	const perf = { audioSamplesOut: 0, msgsSent: 0, whisperMsgsSent: 0 };
	const audio = vi.fn();
	const whisper = vi.fn();
	const batch = createAudioBatchers(backend, whisper, perf, audio);
	installWorkerAudioHandler(backend, 0, perf, whisper, batch.pushWhisper, null, batch.pushAudio);
	const feed = (index, samples, channels) => backend._handleWorkerAudio(index, { samples: samples.buffer, channels, squelchOpen: true });
	return { backend, audio, whisper, feed };
}

describe('stereo PCM delivery', () => {
	it('preserves both channels when queue overflow discards oldest frames', () => {
		const queue = new Float32Array(3);
		let state = appendPcm(queue, undefined, 0, new Float32Array([1, 10, 2, 20]), 2);
		state = appendPcm(queue, state.right, state.length, new Float32Array([3, 30, 4, 40]), 2);
		expect([...queue]).toEqual([2, 3, 4]);
		expect([...state.right]).toEqual([20, 30, 40]);
		expect(state.length).toBe(3);
	});
	it('mixes mono into both channels and sends mono transcription at the correct duration', () => {
		const { audio, whisper, feed } = stream();
		feed(0, interleave(2400, 0.2, 0.6), 2);
		feed(1, new Float32Array(2400).fill(0.1), 1);
		const [pcm, channels] = audio.mock.calls[0];
		expect(channels).toBe(2);
		expect(pcm.length).toBe(4800);
		expect(pcm[0]).toBeCloseTo(0.3);
		expect(pcm[1]).toBeCloseTo(0.7);
		expect(whisper.mock.calls[0][2].length).toBe(2400);
		expect(whisper.mock.calls[0][2][0]).toBeCloseTo(0.4);
	});
	it('uses a 5 ms minimum and flushes a partial batch before changing channel format', () => {
		const audio = vi.fn();
		const batch = createAudioBatchers({}, null, { msgsSent: 0 }, audio);
		batch.pushAudio(interleave(120, 0.1, 0.2), 2);
		expect(audio).not.toHaveBeenCalled();
		batch.pushAudio(new Float32Array(120), 1);
		expect(audio.mock.calls[0][1]).toBe(2);
		expect(audio.mock.calls[0][0].length).toBe(240);
		batch.pushAudio(new Float32Array(120), 1);
		expect(audio.mock.calls[1][1]).toBe(1);
		expect(audio.mock.calls[1][0].length).toBe(240);
	});
	it('round-trips stereo packets and still accepts legacy mono and array views', () => {
		const samples = new Float32Array([0.2, 0.6, 0.4, 0.8]);
		const packet = packAudio(samples, 2);
		expect(unpackAudio(packet)).toEqual({ samples, channels: 2 });
		const envelope = new Uint8Array(packet.byteLength + 8);
		envelope.set(new Uint8Array(packet), 4);
		expect(unpackAudio(new Float32Array(envelope.buffer, 4, packet.byteLength / 4))).toEqual({ samples, channels: 2 });
		expect(unpackAudio(packAudio(samples, 1))).toEqual({ samples, channels: 1 });
		expect([...downmix(samples, 2)]).toEqual([expect.closeTo(0.4), expect.closeTo(0.6)]);
		new DataView(packet).setUint32(4, 99, true);
		expect(() => unpackAudio(packet)).toThrow('Invalid stereo audio packet');
	});
	it('delivers remote stereo to playback and downmixes for transcription', async () => {
		const backend = new Backend();
		backend._remoteClientAudioCb = vi.fn();
		backend._remoteClientWhisperCb = vi.fn();
		backend._whisperEnabled = true;
		backend.vfoParams = [{ freq: 95 }];
		const pcm = interleave(2400, 0.2, 0.6);
		await backend.feedRemoteAudioChunk(packAudio(pcm, 2));
		expect(backend._remoteClientAudioCb).toHaveBeenCalledWith(pcm, 2);
		const mono = backend._remoteClientWhisperCb.mock.calls[0][2];
		expect(mono.length).toBe(2400);
		expect(mono[0]).toBeCloseTo(0.4);
	});
	it('mixes remote mono and stereo without swapping channels', () => {
		const backend = new Backend();
		const state = backend._getOrCreateClientState('client');
		state.workers = [{}, {}];
		state.params = [
			{ enabled: true, volume: 100 },
			{ enabled: true, volume: 100 },
		];
		state.audioQueues = [0, 1].map(() => ({ queue: new Float32Array(24000), len: 0 }));
		backend._remoteHostAudioCb = vi.fn();
		backend._queueRemoteAudio('client', 0, interleave(2400, 0.2, 0.6), 2);
		backend._queueRemoteAudio('client', 1, new Float32Array(2400).fill(0.1), 1);
		const [, pcm, channels] = backend._remoteHostAudioCb.mock.calls[0];
		expect(channels).toBe(2);
		expect(pcm.length).toBe(4800);
		expect(pcm[0]).toBeCloseTo(0.3);
		expect(pcm[1]).toBeCloseTo(0.7);
	});
	it('schedules two browser channels at 48 kHz with correct playback duration', () => {
		const channels = [new Float32Array(2400), new Float32Array(2400)];
		const source = { connect: vi.fn(), start: vi.fn() };
		const context = {
			currentTime: 1,
			state: 'running',
			createBufferSource: () => source,
			createBuffer: vi.fn(() => ({ duration: 0.05, getChannelData: (index) => channels[index] })),
		};
		const app = {
			...audioMethods,
			vfos: [{ enabled: true }],
			audioCtx: context,
			gainNode: {},
			audioRingBuf: new Float32Array(4800),
			audioRingPos: 0,
			nextPlayTime: 0,
		};
		app.playAudio(interleave(1200, 0.2, 0.6), 2);
		expect(context.createBuffer).not.toHaveBeenCalled();
		app.playAudio(interleave(1200, 0.2, 0.6), 2);
		expect(context.createBuffer).toHaveBeenCalledWith(2, 2400, 48000);
		expect(channels[0][0]).toBeCloseTo(0.2);
		expect(channels[1][0]).toBeCloseTo(0.6);
		expect(app.nextPlayTime).toBeCloseTo(1.15);
	});
	it('counts exhausted playback schedules cumulatively without counting startup or reset', () => {
		const context = {
			currentTime: 1,
			createBuffer: () => ({ duration: 0.05, getChannelData: () => new Float32Array(2400) }),
			createBufferSource: () => ({ connect() {}, start() {} }),
		};
		const app = { ...audioMethods, audioCtx: context, gainNode: {}, nextPlayTime: 0, audioGapCount: 0, audioGapMs: 0 };
		const pcm = new Float32Array(2400);
		app._scheduleAudioChunk(pcm);
		expect(app.audioGapCount).toBe(0);
		context.currentTime = 1.16;
		app._scheduleAudioChunk(pcm);
		expect(app.audioGapCount).toBe(1);
		expect(app.audioGapMs).toBeCloseTo(110);
		context.currentTime = 1.17;
		app._scheduleAudioChunk(pcm);
		expect(app.audioGapCount).toBe(1);
		context.currentTime = 1.4;
		app._scheduleAudioChunk(pcm);
		expect(app.audioGapCount).toBe(2);
		expect(app.audioGapMs).toBeCloseTo(250);
		app.nextPlayTime = 0;
		context.currentTime = 3;
		app._scheduleAudioChunk(pcm);
		expect(app.audioGapCount).toBe(2);
	});
	it('absorbs repeated 80ms delivery delays without gaps or growing playback latency', () => {
		const starts = [];
		const context = {
			currentTime: 0,
			createBuffer: () => ({ duration: 0.05, getChannelData: () => new Float32Array(2400) }),
			createBufferSource: () => ({
				connect() {},
				start(time) {
					starts.push(time);
				},
			}),
		};
		const app = { ...audioMethods, audioCtx: context, gainNode: {}, nextPlayTime: 0, audioGapCount: 0, audioGapMs: 0 };
		const pcm = new Float32Array(2400);
		app._scheduleAudioChunk(pcm);
		for (let batch = 1; batch <= 100; batch++) {
			// Delayed tasks catch up on the following batch; input rate stays 48kHz.
			context.currentTime = batch * 0.05 + (batch % 2 ? 0.08 : 0);
			context.currentTime = Math.max(context.currentTime, (batch - 1) * 0.05 + 0.08);
			app._scheduleAudioChunk(pcm);
		}
		expect(app.audioGapCount).toBe(0);
		expect(app.audioGapMs).toBe(0);
		expect(starts[0]).toBeCloseTo(0.1);
		expect(starts[100]).toBeCloseTo(5.1);
	});
});
