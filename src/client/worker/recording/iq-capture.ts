/** Bounded, sample-exact recording of the signed interleaved I/Q receiver stream. */
export class IqCapture {
	private recording?: {
		data: Int8Array<ArrayBuffer>;
		offset: number;
		resolve: (data: Int8Array<ArrayBuffer>) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	};

	start(sampleRate: number, seconds: number): Promise<Int8Array<ArrayBuffer>> {
		if (this.recording) throw new Error('An IQ capture is already running');
		const samples = Math.round(sampleRate * seconds);
		if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(samples) || samples < 1 || samples * 2 > 64 * 1024 * 1024)
			throw new Error('Choose a capture duration between one sample and 64 MiB');
		return new Promise((resolve, reject) => {
			this.recording = {
				data: new Int8Array(samples * 2),
				offset: 0,
				resolve,
				reject,
				timer: setTimeout(() => this.cancel('IQ capture timed out waiting for samples'), Math.max(10000, seconds * 3000)),
			};
		});
	}

	push(data: Int8Array): void {
		const recording = this.recording;
		if (!recording) return;
		const length = Math.min(data.length, recording.data.length - recording.offset);
		recording.data.set(data.subarray(0, length), recording.offset);
		recording.offset += length;
		if (recording.offset === recording.data.length) {
			clearTimeout(recording.timer);
			this.recording = undefined;
			recording.resolve(recording.data);
		}
	}

	cancel(message = 'IQ capture cancelled'): void {
		if (!this.recording) return;
		clearTimeout(this.recording.timer);
		this.recording.reject(new Error(message));
		this.recording = undefined;
	}
}
