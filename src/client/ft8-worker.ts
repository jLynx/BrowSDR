import { createFT8Decoder } from './ft8/decoder';
import { FT8Stream } from './ft8/stream';

let stream: FT8Stream | null = null;
let lastStatus = 0;
let decoder: Awaited<ReturnType<typeof createFT8Decoder>>;
self.onmessage = async (event: MessageEvent) => {
	try {
		const msg = event.data;
		if (msg.type === 'init') {
			decoder = await createFT8Decoder();
			stream = new FT8Stream((audio, slot) => {
				self.postMessage({ type: 'decoding', slot });
				const start = performance.now();
				const messages = decoder.decode(audio);
				self.postMessage({ type: 'result', slot, messages, duration: performance.now() - start });
			});
			self.postMessage({ type: 'ready' });
		} else if (msg.type === 'audio' && stream) {
			stream.push(new Float32Array(msg.samples), msg.endTime);
			if (msg.endTime - lastStatus > 500) {
				lastStatus = msg.endTime;
				self.postMessage({ type: 'progress', progress: stream.progress, collecting: stream.collecting });
			}
		}
	} catch (error) {
		self.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
	}
};
