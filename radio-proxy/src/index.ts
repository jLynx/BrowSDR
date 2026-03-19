import { loadConfig } from './config.js';
import { WebRTCClient } from './webrtc-client.js';
import { AudioEncoder } from './audio-encoder.js';
import { StreamServer } from './stream-server.js';
import * as log from './logger.js';

async function main() {
	const config = loadConfig();

	log.info('BrowSDR Radio Proxy starting...');
	log.info(`Host: ${config.hostId}`);
	log.info(`VFO: ${config.vfo.freq} MHz ${config.vfo.mode.toUpperCase()} (BW: ${config.vfo.bandwidth} Hz)`);
	log.info(`Stream: MP3 @ ${config.mp3Bitrate}kbps on port ${config.streamPort}`);

	// Start the HTTP stream server
	const server = new StreamServer(config.streamPort);
	server.setStatus({
		connected: false,
		frequency: config.vfo.freq,
		mode: config.vfo.mode,
		bandwidth: config.vfo.bandwidth,
		hostId: config.hostId,
	});
	server.start();

	// Start the MP3 encoder (ffmpeg)
	const encoder = new AudioEncoder(config.mp3Bitrate);
	encoder.onData = (chunk) => server.broadcastMp3Chunk(chunk);
	encoder.start();

	// Connect to the WebSDR host via WebRTC
	const client = new WebRTCClient(config, {
		onConnected: (syncData) => {
			log.info('Connected to WebSDR host — audio streaming active');
			server.setStatus({ connected: true });
		},
		onAudioChunk: (data) => {
			// Data arrives as ArrayBuffer from the raw data channel
			// PeerJS raw serialization may deliver Buffer or ArrayBuffer in Node.js
			const raw = data as ArrayBuffer | Buffer;
			let buf: ArrayBuffer;
			if (raw instanceof ArrayBuffer) {
				buf = raw;
			} else {
				// Node.js Buffer — extract the underlying ArrayBuffer slice
				const b = raw as Buffer;
				buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
			}
			const samples = new Float32Array(buf);
			encoder.write(samples);
		},
		onDisconnected: () => {
			log.warn('Disconnected from WebSDR host — waiting for reconnect...');
			server.setStatus({ connected: false });
		},
		onError: (err) => {
			log.error('WebRTC error:', err.message);
		},
	});

	await client.connect();

	// Graceful shutdown
	const shutdown = () => {
		log.info('Shutting down...');
		client.close();
		encoder.stop();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

main().catch((err) => {
	log.error('Fatal error:', err);
	process.exit(1);
});
