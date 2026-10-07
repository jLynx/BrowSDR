/** Track concurrent and cached files without leaving the UI on a completed download. */
export class WhisperProgress {
	private files = new Map<string, { progress: number; done: boolean; total: number }>();
	private displayed = 0;
	constructor(private send: (message: any) => void, private expectedBytes = 0) {}
	update(event: { status: string; file?: string; progress?: number; total?: number }): void {
		if (!event.file || !['initiate', 'progress', 'done'].includes(event.status)) return;
		const previous = this.files.get(event.file);
		this.files.set(event.file, {
			progress: event.status === 'done' ? 100 : event.progress ?? previous?.progress ?? 0,
			done: event.status === 'done' || previous?.done === true,
			total: event.total || previous?.total || 0,
		});
		const entries = [...this.files.entries()];
		const pending = entries.filter(([, file]) => !file.done);
		const current = pending.find(([, file]) => file.progress < 100) || pending[0];
		const sized = entries.filter(([name, file]) => file.total > 0 && /\.onnx(?:_data)?$/.test(name));
		const totalBytes = sized.reduce((sum, [, file]) => sum + file.total, 0);
		const receivedBytes = sized.reduce((sum, [, file]) => sum + file.total * file.progress / 100, 0);
		// Files are discovered progressively. Keep the estimate monotonic, reserving
		// 100% for the completed pipeline rather than a single completed file.
		const combined = totalBytes ? receivedBytes / Math.max(totalBytes, this.expectedBytes) * 100 : 0;
		this.displayed = Math.max(this.displayed, Math.min(99, Math.floor(combined)));
		this.send({
			type: 'loading',
			phase: current ? (current[1].progress >= 100 ? 'finalizing' : 'downloading') : 'initializing',
			progress: this.displayed,
			file: '',
			filesDone: entries.length - pending.length,
			filesTotal: entries.length,
		});
	}
}
