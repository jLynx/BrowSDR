/** Receiver streams share one PeerJS connection. Preserve the original payload bytes. */
const MAGIC = [0x42, 0x53, 0x44, 0x52];
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function packReceiverChunk(receiverId: string, chunk: ArrayBuffer | ArrayBufferView): ArrayBuffer {
	const id = encoder.encode(receiverId);
	if (!id.length || id.length > 65535) throw new Error('Invalid receiver ID');
	const bytes = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	const packet = new Uint8Array(6 + id.length + bytes.length);
	packet.set(MAGIC);
	new DataView(packet.buffer).setUint16(4, id.length, true);
	packet.set(id, 6);
	packet.set(bytes, 6 + id.length);
	return packet.buffer;
}

export function unpackReceiverChunk(chunk: ArrayBuffer | ArrayBufferView): { receiverId: string | null; payload: ArrayBuffer } | null {
	const bytes = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	const enveloped = MAGIC.every((value, index) => bytes[index] === value);
	if (!enveloped) return { receiverId: null, payload: bytes.slice().buffer };
	if (bytes.length < 6) return null;
	const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(4, true);
	if (!length || 6 + length >= bytes.length) return null;
	try {
		return { receiverId: decoder.decode(bytes.subarray(6, 6 + length)), payload: bytes.slice(6 + length).buffer };
	} catch { return null; }
}

/** Matches WebRTCHandler's receiver-facing API, while the workspace owns the connection. */
export class ReceiverTransport {
	onStatusChange: ((status: any) => void) | null = null;
	onCommand: ((...args: any[]) => void) | null = null;
	onFftChunk: ((chunk: ArrayBuffer) => void) | null = null;
	onAudioChunk: ((chunk: ArrayBuffer) => void) | null = null;
	constructor(public receiverId: string, private transport: any, private onClose: () => void) {}
	sendCommand(command: any) { this.transport.sendCommand({ ...command, receiverId: this.receiverId }); }
	sendCommandTo(clientId: string, command: any) { this.transport.sendCommandTo(clientId, { ...command, receiverId: this.receiverId }); }
	sendFftChunk(chunk: ArrayBuffer | ArrayBufferView) { this.transport.sendFftChunk(packReceiverChunk(this.receiverId, chunk)); }
	sendAudioChunkTo(clientId: string, chunk: ArrayBuffer | ArrayBufferView) { this.transport.sendAudioChunkTo(clientId, packReceiverChunk(this.receiverId, chunk)); }
	kickClient(clientId: string) { this.transport.kickClient(clientId); }
	close() { this.onClose(); }
}
