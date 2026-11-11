import { describe, expect, it } from 'vitest';
import { HdAudioPacer } from '@/worker/decoders/hd-radio/audio';
import { AdaptivePlaybackBuffer } from '@/audio/playback/buffer';
import { HD_IQ_RATE } from '@/worker/decoders/hd-radio/types';

describe('HD Radio audio pacing', () => {
	it('plays 93ms decoder bursts through the shared 100ms player without gaps or overflow', () => {
		const pacer = new HdAudioPacer();
		const player = new AdaptivePlaybackBuffer();
		const block = new Float32Array(Math.round((4096 * 48000) / 44100) * 2).fill(0.25);
		const output = [new Float32Array(128), new Float32Array(128)];
		let nextBurst = 0;
		let nextIq = 0;
		let pcmFrames = 0;
		for (let rendered = 0; rendered < 48000 * 30; rendered += 128) {
			const now = rendered / 48000;
			while (nextIq <= now) {
				while (nextBurst <= nextIq) {
					pacer.push(block);
					nextBurst += 4096 / 44100;
				}
				const pcm = pacer.read(HD_IQ_RATE * 0.008);
				if (pcm) {
					pcmFrames += pcm.length / 2;
					player.push(pcm, 2, now);
				}
				nextIq += 0.008;
			}
			player.render(output, 48000);
		}
		expect(pcmFrames).toBeGreaterThan(48000 * 29.8);
		expect(player.stats()).toMatchObject({ gapCount: 0, droppedFrames: 0 });
	});

	it('keeps stereo ordering, fractional timing and a bounded queue', () => {
		const pacer = new HdAudioPacer();
		pacer.push(Float32Array.from({ length: 96000 }, (_, i) => (i % 2 ? -0.5 : 0.25)));
		let frames = 0;
		for (let i = 0; i < 100; i++) {
			const pcm = pacer.read(1000);
			frames += pcm.length / 2;
			expect(pcm[0]).toBe(0.25);
			expect(pcm[1]).toBe(-0.5);
		}
		expect(frames).toBe(Math.floor((100000 * 48000) / HD_IQ_RATE));
		expect(pacer.read(HD_IQ_RATE).length).toBe((24000 - frames) * 2);
		expect(pacer.read(HD_IQ_RATE)).toBeNull();
	});
});
