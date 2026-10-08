/** The receiver capabilities used by the page-level Media Session. */
export interface MediaSessionReceiver {
	connected: boolean;
	running: boolean;
	_removing?: boolean;
	_mediaAudioEl?: HTMLAudioElement | null;
	audioCtx?: AudioContext | null;
	togglePlay(): Promise<void>;
}

/** One page-level Media Session represents all receivers in a workspace. */
export class WorkspaceMediaSession {
	private registered = false;
	constructor(
		private receivers: () => readonly MediaSessionReceiver[],
		private selected: () => MediaSessionReceiver | undefined,
	) {}

	update(): void {
		const session = navigator.mediaSession;
		if (!session) return;
		const connected = this.receivers().filter((app) => app.connected && !app._removing);
		const running = connected.filter((app) => app.running);
		if (!connected.length) {
			this.dispose();
			return;
		}
		if (!this.registered) {
			session.setActionHandler('play', () => {
				const candidates = this.receivers().filter((app) => app.connected && !app._removing);
				const active = candidates.filter((app) => app.running);
				if (active.length) {
					for (const app of active) {
						app._mediaAudioEl?.play().catch(() => {});
						if (app.audioCtx?.state === 'suspended') app.audioCtx.resume().catch(() => {});
					}
				} else {
					const app = candidates.find((app) => app === this.selected()) || candidates[0];
					app?.togglePlay().catch(console.error);
				}
			});
			// Keep the existing mobile notification behavior; stopping is explicit.
			session.setActionHandler('pause', () => this.update());
			session.setActionHandler('stop', () => {
				for (const app of this.receivers().filter((app) => app.running && !app._removing)) {
					app.togglePlay().catch(console.error);
				}
			});
			this.registered = true;
		}
		if (typeof MediaMetadata !== 'undefined')
			session.metadata = new MediaMetadata({
				title: 'BrowSDR',
				artist: running.length ? `Receiving on ${running.length} SDR${running.length === 1 ? '' : 's'}` : 'Reception paused',
				artwork: [96, 192, 512].map((size) => ({ src: `/icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png' })),
			});
		session.playbackState = running.length ? 'playing' : 'paused';
	}

	dispose(): void {
		const session = navigator.mediaSession;
		if (!session || !this.registered) return;
		for (const action of ['play', 'pause', 'stop'] as const) session.setActionHandler(action, null);
		session.playbackState = 'none';
		session.metadata = null;
		this.registered = false;
	}
}
