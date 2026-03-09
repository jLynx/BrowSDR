export class WebRTCHandler {
	constructor(isHost, remoteId = null) {
		this.isHost = isHost;
		this.peer = null;
		this.connCmd = null;
		this.connIq = null;
		this.connIqOverflow = false; // Add High/Low Watermark state

		this.remoteId = remoteId; // Used by client to connect to host

		this.onStatusChange = null;
		this.onCommand = null;
		this.onIqChunk = null;
	}

	async init() {
		// Import peerjs dynamically from window.Peer since it's loaded as a script
		if (!window.Peer) {
			console.error("PeerJS not loaded!");
			return false;
		}

		return new Promise((resolve, reject) => {
			if (this.isHost) {
				// Host generates a random alphabet id
				const id = 'browsdr-' + Math.random().toString(36).substring(2, 8);
				this.peer = new window.Peer(id);
			} else {
				// Client generates random id, will connect to this.remoteId
				this.peer = new window.Peer();
			}

			this.peer.on('open', (id) => {
				console.log('My peer ID is: ' + id);
				
				if (this.isHost) {
					this._setStatus({ status: 'ready', id: id });
				} else {
					this._setStatus({ status: 'connecting' });
					if (this.remoteId) {
						this._connectToHost();
					}
				}
				resolve(id);
			});

			this.peer.on('connection', (conn) => {
				if (this.isHost) {
					this._handleIncomingConnection(conn);
				}
			});

			this.peer.on('error', (err) => {
				console.error('PeerJS error:', err);
				this._setStatus({ status: 'error', error: err.type });
				reject(err);
			});
			
			this.peer.on('disconnected', () => {
				this._setStatus({ status: 'disconnected' });
			});
		});
	}

	_setStatus(msgObj) {
		console.log(`[WebRTC]`, msgObj);
		if (this.onStatusChange) this.onStatusChange(msgObj);
	}

	_connectToHost() {
		// Client connects to Host. Open two channels.
		this.connCmd = this.peer.connect(this.remoteId, { label: 'cmd', reliable: true });
		this.connIq = this.peer.connect(this.remoteId, { label: 'iq', reliable: false }); // Unreliable for speed

		this._setupConnectionListeners(this.connCmd, 'cmd');
		this._setupConnectionListeners(this.connIq, 'iq');
	}

	_handleIncomingConnection(conn) {
		// Host receives connection
		if (conn.label === 'cmd') {
			this.connCmd = conn;
			this._setupConnectionListeners(conn, 'cmd');
		} else if (conn.label === 'iq') {
			this.connIq = conn;
			this._setupConnectionListeners(conn, 'iq');
		}
	}

	_setupConnectionListeners(conn, type) {
		conn.on('open', () => {
			console.log(`[WebRTC] ${type} channel opened.`);
			if (this.connCmd && this.connCmd.open && this.connIq && this.connIq.open) {
				this._setStatus({ status: 'connected' });
			}
		});

		conn.on('data', (data) => {
			if (type === 'cmd') {
				if (this.onCommand) this.onCommand(data);
			} else if (type === 'iq') {
				if (this.onIqChunk) this.onIqChunk(data);
			}
		});

		conn.on('close', () => {
			console.log(`[WebRTC] ${type} channel closed.`);
			this._setStatus({ status: 'disconnected' });
		});
	}

	sendCommand(cmd) {
		if (this.connCmd && this.connCmd.open) {
			this.connCmd.send(cmd);
		}
	}

	sendIqChunk(chunk) {
		if (this.connIq && this.connIq.open) {
			// Web-888 style High/Low Watermark Backpressure
			// PeerJS bufferedAmount grows when socket can't flush fast enough
			if (this.connIq.dataChannel) {
				const buffered = this.connIq.dataChannel.bufferedAmount;
				if (buffered > 2097152) { // 2 MB High Watermark
					this.connIqOverflow = true;
				} else if (buffered < 524288) { // 500 KB Low Watermark
					this.connIqOverflow = false;
				}
				if (this.connIqOverflow) {
					return; // Drop chunk safely to avoid compounding lag
				}
			}

			// Send primitive ArrayBuffer to skip wrapper structural cloning loop
			this.connIq.send(chunk.buffer || chunk);
		}
	}
	
	close() {
		if (this.connCmd) this.connCmd.close();
		if (this.connIq) this.connIq.close();
		if (this.peer) this.peer.destroy();
	}
}
