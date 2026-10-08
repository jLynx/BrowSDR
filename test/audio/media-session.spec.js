import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceMediaSession } from '@/app/audio/media-session';

afterEach(() => vi.unstubAllGlobals());

describe('workspace Media Session', () => {
	it('keeps controls while another SDR receives, resumes the selected paused SDR, and stops all running SDRs', async () => {
		const handlers = new Map();
		const session = { setActionHandler: vi.fn((action, handler) => handlers.set(action, handler)) };
		vi.stubGlobal('navigator', { mediaSession: session });
		vi.stubGlobal(
			'MediaMetadata',
			class {
				constructor(data) {
					Object.assign(this, data);
				}
			},
		);
		const receiver = () => {
			const app = {
				connected: true,
				running: true,
				audioCtx: { state: 'suspended', resume: vi.fn(async () => {}) },
				_mediaAudioEl: { play: vi.fn(async () => {}) },
			};
			app.togglePlay = vi.fn(async () => {
				app.running = !app.running;
			});
			return app;
		};
		const first = receiver(),
			second = receiver();
		let apps = [first, second];
		const media = new WorkspaceMediaSession(
			() => apps,
			() => second,
		);
		media.update();
		expect(session.playbackState).toBe('playing');
		expect(session.metadata.artist).toBe('Receiving on 2 SDRs');
		const play = handlers.get('play');
		first.running = false;
		media.update();
		expect(session.playbackState).toBe('playing');
		expect(handlers.get('play')).toBe(play);
		play();
		expect(second.audioCtx.resume).toHaveBeenCalledOnce();
		expect(first.audioCtx.resume).not.toHaveBeenCalled();
		second.running = false;
		media.update();
		expect(session.playbackState).toBe('paused');
		play();
		expect(second.togglePlay).toHaveBeenCalledOnce();
		first.running = true;
		handlers.get('stop')();
		expect(first.togglePlay).toHaveBeenCalledOnce();
		expect(second.togglePlay).toHaveBeenCalledTimes(2);
		apps = [];
		media.update();
		expect([...handlers.values()]).toEqual([null, null, null]);
		expect(session.playbackState).toBe('none');
		expect(session.metadata).toBeNull();
	});
	it('is safe when the browser has no Media Session API', () => {
		vi.stubGlobal('navigator', {});
		const media = new WorkspaceMediaSession(
			() => [],
			() => undefined,
		);
		expect(() => {
			media.update();
			media.dispose();
		}).not.toThrow();
	});
});
