import express, { type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as log from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface StreamStatus {
	connected: boolean;
	frequency: number;
	mode: string;
	bandwidth: number;
	hostId: string;
}

export class StreamServer {
	private port: number;
	private listeners = new Set<Response>();
	private startTime = Date.now();
	private status: StreamStatus = {
		connected: false,
		frequency: 0,
		mode: '',
		bandwidth: 0,
		hostId: '',
	};

	constructor(port: number) {
		this.port = port;
	}

	start(): void {
		const app = express();

		app.get('/', (_req, res) => {
			res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
		});

		app.get('/stream', (req, res) => {
			res.writeHead(200, {
				'Content-Type': 'audio/mpeg',
				'Transfer-Encoding': 'chunked',
				'Connection': 'keep-alive',
				'Cache-Control': 'no-cache, no-store',
				'X-Content-Type-Options': 'nosniff',
				'icy-name': 'BrowSDR Radio Stream',
				'icy-description': `${this.status.frequency} MHz ${this.status.mode.toUpperCase()}`,
			});

			this.listeners.add(res);
			log.info(`Listener connected (${this.listeners.size} total)`);

			req.on('close', () => {
				this.listeners.delete(res);
				log.info(`Listener disconnected (${this.listeners.size} total)`);
			});
		});

		app.get('/status', (_req, res) => {
			res.json({
				...this.status,
				listeners: this.listeners.size,
				uptime: Math.floor((Date.now() - this.startTime) / 1000),
			});
		});

		app.listen(this.port, () => {
			log.info(`Stream server listening on http://localhost:${this.port}`);
			log.info(`Stream URL: http://localhost:${this.port}/stream`);
		});
	}

	broadcastMp3Chunk(chunk: Buffer): void {
		for (const res of this.listeners) {
			if (res.writableEnded) {
				this.listeners.delete(res);
				continue;
			}

			// Check backpressure — drop slow clients
			if (res.writableLength > 524288) {
				log.warn('Dropping slow listener (buffer > 512KB)');
				res.end();
				this.listeners.delete(res);
				continue;
			}

			res.write(chunk);
		}
	}

	getListenerCount(): number {
		return this.listeners.size;
	}

	setStatus(update: Partial<StreamStatus>): void {
		Object.assign(this.status, update);
	}
}
