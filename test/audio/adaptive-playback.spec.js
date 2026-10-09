import { describe, expect, it } from 'vitest';
import { AdaptivePlaybackBuffer } from '@/audio/playback/buffer';

const block = (frames = 128) => [new Float32Array(frames), new Float32Array(frames)];
const pcm = (frames) => new Float32Array(frames).fill(0.25);

function simulate(seconds, packetFrames = 240, deliveryRate = 48000, arrivalDelay = () => 0) {
	const queue = new AdaptivePlaybackBuffer();
	const output = block();
	let packet = 0;
	for (let frame = 0; frame < seconds * 48000; frame += 128) {
		const now = frame / 48000;
		while ((packet * packetFrames) / deliveryRate + arrivalDelay(packet) <= now) {
			queue.push(pcm(packetFrames), 1, now);
			packet++;
		}
		queue.render(output, 48000);
	}
	return queue.stats();
}

describe('adaptive audio playback', () => {
	it('reduces latency on steady delivery while keeping the queue bounded', () => {
		const stats = simulate(60);
		expect(stats.targetMs).toBeLessThan(12);
		expect(stats.queueMs).toBeLessThan(20);
		expect(stats.gapCount).toBe(0);
		expect(stats.droppedFrames).toBe(0);
	});
	it('compensates sustained 0.1% under-delivery without draining into a gap', () => {
		const stats = simulate(120, 240, 47952);
		expect(stats.gapCount).toBe(0);
		expect(stats.droppedFrames).toBe(0);
		expect(stats.rate).toBeLessThan(1);
		expect(stats.rate).toBeGreaterThanOrEqual(0.995);
		expect(stats.queueMs).toBeGreaterThan(0);
	});
	it.each([626, 2400])('handles %i-frame USB or remote packets without discarding PCM', (packetFrames) => {
		const stats = simulate(60, packetFrames, 47952);
		expect(stats.gapCount).toBe(0);
		expect(stats.droppedFrames).toBe(0);
		expect(stats.targetMs).toBeGreaterThanOrEqual(packetFrames / 48);
		expect(stats.queueMs).toBeLessThanOrEqual(100);
	});
	it('keeps gaps visible when sustained loss exceeds the maximum rate correction', () => {
		const stats = simulate(60, 240, 47000);
		expect(stats.gapCount).toBeGreaterThan(0);
		expect(stats.gapMs).toBeGreaterThan(0);
		expect(stats.targetMs).toBeLessThanOrEqual(100);
		expect(stats.rate).toBeGreaterThanOrEqual(0.995);
	});
	it('grows the reserve for periodic stalls then lowers it gradually', () => {
		const delayed = simulate(30, 240, 48000, (packet) => (packet % 100 === 50 ? 0.03 : 0));
		expect(delayed.targetMs).toBeGreaterThan(30);
		expect(delayed.targetMs).toBeLessThanOrEqual(100);
		expect(delayed.gapCount).toBeLessThan(4);
	});
	it('counts actual starvation silence once and excludes intentional reset', () => {
		const queue = new AdaptivePlaybackBuffer();
		queue.push(pcm(1200), 1, 0);
		queue.push(pcm(240), 1, 0.005);
		queue.render(block(1440), 48000);
		queue.render(block(480), 48000);
		queue.render(block(480), 48000);
		expect(queue.stats().gapCount).toBe(1);
		expect(queue.stats().gapMs).toBeCloseTo(20, 1);
		queue.reset();
		queue.render(block(4800), 48000);
		expect(queue.stats().gapCount).toBe(1);
		expect(queue.stats().gapMs).toBeLessThan(21);
		queue.reset(true);
		expect(queue.stats().gapCount).toBe(0);
	});
	it('discards only whole oldest frames at the 100ms storage limit', () => {
		const queue = new AdaptivePlaybackBuffer();
		const stereo = new Float32Array(6000 * 2);
		for (let frame = 0; frame < 6000; frame++) {
			stereo[frame * 2] = frame;
			stereo[frame * 2 + 1] = -frame;
		}
		queue.push(stereo, 2, 0);
		expect(queue.stats().queueMs).toBe(100);
		expect(queue.stats().droppedFrames).toBe(1200);
		const output = block();
		queue.render(output, 48000);
		expect(output[0][0]).toBe(1200);
		for (let frame = 0; frame < 128; frame++) expect(output[1][frame]).toBe(-output[0][frame]);
	});
	it('resamples a continuous stereo ramp for a different audio device clock', () => {
		const queue = new AdaptivePlaybackBuffer();
		const stereo = new Float32Array(2400 * 2);
		for (let frame = 0; frame < 2400; frame++) {
			stereo[frame * 2] = frame / 2400;
			stereo[frame * 2 + 1] = -frame / 2400;
		}
		queue.push(stereo, 2, 0);
		queue.push(new Float32Array(480), 2, 0.005);
		const output = block(882);
		queue.render(output, 44100);
		expect(output[0][881]).toBeCloseTo((881 * 48000) / 44100 / 2400, 3);
		for (let frame = 1; frame < 882; frame++) {
			expect(output[0][frame] - output[0][frame - 1]).toBeLessThan(0.00046);
			expect(output[1][frame]).toBe(-output[0][frame]);
		}
		expect(queue.stats().gapCount).toBe(0);
	});
});
