import { AdaptivePlaybackBuffer } from './buffer';
import type { PlaybackMessage } from './types';

class RadioPlaybackProcessor extends AudioWorkletProcessor {
	private readonly queue = new AdaptivePlaybackBuffer();
	private nextReport = 0;

	constructor() {
		super();
		this.port.onmessage = (event: MessageEvent<PlaybackMessage>) => {
			const message = event.data;
			if (message.type === 'reset') this.queue.reset(message.clearCounters);
			else this.queue.push(message.samples, message.channels, currentTime);
		};
	}

	process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
		this.queue.render(outputs[0], sampleRate);
		if (currentTime >= this.nextReport) {
			this.port.postMessage(this.queue.stats());
			this.nextReport = currentTime + 0.25;
		}
		return true;
	}
}

registerProcessor('radio-playback', RadioPlaybackProcessor);
