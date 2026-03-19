import { spawn, type ChildProcess } from 'node:child_process';
import * as log from './logger.js';

export class AudioEncoder {
	private ffmpeg: ChildProcess | null = null;
	private bitrate: number;
	private restarting = false;

	onData: ((chunk: Buffer) => void) | null = null;

	constructor(bitrate: number) {
		this.bitrate = bitrate;
	}

	start(): void {
		this.ffmpeg = spawn('ffmpeg', [
			'-hide_banner',
			'-loglevel', 'warning',
			'-f', 's16le',
			'-ar', '48000',
			'-ac', '1',
			'-i', 'pipe:0',
			'-codec:a', 'libmp3lame',
			'-b:a', `${this.bitrate}k`,
			'-f', 'mp3',
			'pipe:1',
		], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		this.ffmpeg.stdout!.on('data', (chunk: Buffer) => {
			this.onData?.(chunk);
		});

		this.ffmpeg.stderr!.on('data', (data: Buffer) => {
			const msg = data.toString().trim();
			if (msg) log.warn('ffmpeg:', msg);
		});

		this.ffmpeg.on('error', (err) => {
			log.error('ffmpeg spawn error:', err.message);
			log.error('Is ffmpeg installed and in PATH?');
		});

		this.ffmpeg.on('close', (code) => {
			log.warn(`ffmpeg exited with code ${code}`);
			this.ffmpeg = null;
			if (!this.restarting) {
				this.restarting = true;
				setTimeout(() => {
					this.restarting = false;
					log.info('Restarting ffmpeg encoder...');
					this.start();
				}, 1000);
			}
		});

		log.info(`MP3 encoder started (${this.bitrate}kbps)`);
	}

	write(samples: Float32Array): void {
		if (!this.ffmpeg?.stdin?.writable) return;

		const pcm = Buffer.alloc(samples.length * 2);
		for (let i = 0; i < samples.length; i++) {
			const s = Math.max(-1, Math.min(1, samples[i]));
			const val = s < 0 ? s * 32768 : s * 32767;
			pcm.writeInt16LE(Math.round(val), i * 2);
		}

		this.ffmpeg.stdin.write(pcm);
	}

	stop(): void {
		this.restarting = true;
		if (this.ffmpeg) {
			this.ffmpeg.stdin?.end();
			this.ffmpeg.kill();
			this.ffmpeg = null;
		}
	}
}
