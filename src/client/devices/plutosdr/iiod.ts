import type { IioAttributeTarget, IiodPipeEndpoints } from './types';

/*
IIOD client for one libiio USB pipe (a bulk IN/OUT endpoint couple).

The device runs a separate iiod text-protocol parser per pipe. Commands end
with CRLF; replies start with a decimal line holding a byte count or a
negative errno. Bulk reads are always whole USB packets, and any bytes read
past the current reply are kept for the next one.
*/

const LINE_READ_BYTES = 1024;
/** libiio caps URBs at 1 MiB because some host controllers lack scatter-gather. */
const MAX_TRANSFER_BYTES = 1 << 20;
const MAX_LINE_BYTES = 1 << 20;
const CONTROL_TIMEOUT_MS = 5000;
/** `major.minor.tag`, matched at the end: stale bytes without a newline may precede it. */
const VERSION_LINE = /([01])\.(\d{1,3})\.(\S{0,7})$/;
const ERRNO_NAMES: Record<number, string> = {
	1: 'EPERM',
	2: 'ENOENT',
	5: 'EIO',
	6: 'ENXIO',
	9: 'EBADF',
	12: 'ENOMEM',
	13: 'EACCES',
	16: 'EBUSY',
	19: 'ENODEV',
	22: 'EINVAL',
	32: 'EPIPE',
	34: 'ERANGE',
	110: 'ETIMEDOUT',
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class IiodError extends Error {
	constructor(
		readonly command: string,
		readonly code: number,
	) {
		super(`PlutoSDR ${command} failed: ${ERRNO_NAMES[-code] ?? 'error'} (${code})`);
		this.name = 'IiodError';
	}
}

function attributeAddress({ device, channel, attribute }: IioAttributeTarget): string {
	return channel ? `${device.id} ${channel.output ? 'OUTPUT' : 'INPUT'} ${channel.id} ${attribute}` : `${device.id} ${attribute}`;
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
	const filled = chunks.filter((chunk) => chunk.byteLength);
	if (filled.length === 1) return filled[0];
	const joined = new Uint8Array(length);
	let offset = 0;
	for (const chunk of filled) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return joined;
}

export class IiodPipe {
	private buffered: Uint8Array = new Uint8Array(0);
	private lock: Promise<unknown> = Promise.resolve();
	private failure: Error | null = null;

	constructor(
		private readonly usb: USBDevice,
		readonly endpoints: IiodPipeEndpoints,
	) {}

	/** Serialize one command/reply exchange; a reply that never arrives poisons the pipe. */
	exclusive<T>(label: string, task: () => Promise<T>, timeoutMs = CONTROL_TIMEOUT_MS): Promise<T> {
		const run = this.lock.then(async () => {
			if (this.failure) throw this.failure;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					this.failure = new Error(`PlutoSDR did not answer ${label}. Reconnect it and close other applications using it.`);
					reject(this.failure);
				}, timeoutMs);
			});
			try {
				return await Promise.race([task(), timeout]);
			} finally {
				clearTimeout(timer);
			}
		});
		this.lock = run.catch(() => {});
		return run;
	}

	async write(data: string | Uint8Array<ArrayBuffer>): Promise<void> {
		const bytes = typeof data === 'string' ? encoder.encode(data) : data;
		const result = await this.usb.transferOut(this.endpoints.outEndpoint, bytes);
		if (result.status !== 'ok' || result.bytesWritten !== bytes.byteLength)
			throw new Error(`PlutoSDR: USB write failed (${result.status})`);
	}

	private async receive(length: number): Promise<Uint8Array> {
		const { inEndpoint, packetSize } = this.endpoints;
		// Whole packets only: a shorter request overflows when the device sends a full packet.
		const aligned = Math.min(MAX_TRANSFER_BYTES, Math.ceil(length / packetSize) * packetSize);
		const result = await this.usb.transferIn(inEndpoint, aligned);
		if (result.status === 'stall') {
			await this.usb.clearHalt('in', inEndpoint).catch(() => {});
			throw new Error('PlutoSDR: USB endpoint stalled');
		}
		if (result.status !== 'ok' || !result.data) throw new Error(`PlutoSDR: USB read failed (${result.status})`);
		return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
	}

	private take(length: number): Uint8Array {
		const head = this.buffered.subarray(0, length);
		this.buffered = this.buffered.subarray(length);
		return head;
	}

	async readLine(): Promise<string> {
		for (;;) {
			const end = this.buffered.indexOf(0x0a);
			if (end >= 0) return decoder.decode(this.take(end + 1).subarray(0, end)).replace(/\r$/, '');
			if (this.buffered.byteLength > MAX_LINE_BYTES) throw new Error('PlutoSDR: IIOD reply line is too long');
			const chunk = await this.receive(LINE_READ_BYTES);
			this.buffered = concat([this.buffered, chunk], this.buffered.byteLength + chunk.byteLength);
		}
	}

	async readExact(length: number): Promise<Uint8Array> {
		if (this.buffered.byteLength >= length) return this.take(length);
		const chunks = [this.take(this.buffered.byteLength)];
		let received = chunks[0].byteLength;
		while (received < length) {
			const chunk = await this.receive(length - received);
			chunks.push(chunk);
			received += chunk.byteLength;
		}
		const data = concat(chunks, received);
		this.buffered = data.subarray(length);
		return data.subarray(0, length);
	}

	/** Like libiio, skip blank lines and parse the first decimal value. */
	async readInteger(): Promise<number> {
		for (;;) {
			const line = (await this.readLine()).trim();
			if (!line) continue;
			if (!/^-?\d+/.test(line)) throw new Error(`PlutoSDR: unexpected IIOD reply "${line.slice(0, 40)}"`);
			return Number.parseInt(line, 10);
		}
	}

	/** Write a command and return its integer status. */
	command(command: string): Promise<number> {
		return this.exclusive(command.trim(), async () => {
			await this.write(command);
			return this.readInteger();
		});
	}

	/** Also resynchronizes: lines left over from an interrupted session are skipped. */
	version(): Promise<string> {
		return this.exclusive('VERSION', async () => {
			await this.write('VERSION\r\n');
			for (let skipped = 0; skipped < 1000; skipped++) {
				const match = VERSION_LINE.exec((await this.readLine()).trim());
				if (match) return `${match[1]}.${match[2]}${match[3] ? ` (${match[3]})` : ''}`;
			}
			throw new Error('PlutoSDR: no IIOD version reply');
		});
	}

	printContext(): Promise<string> {
		return this.exclusive('PRINT', async () => {
			await this.write('PRINT\r\n');
			const length = await this.readInteger();
			if (length < 0) throw new IiodError('PRINT', length);
			// The XML is followed by a newline.
			const xml = await this.readExact(length + 1);
			return decoder.decode(xml.subarray(0, length));
		});
	}

	readAttribute(target: IioAttributeTarget): Promise<string> {
		const command = `READ ${attributeAddress(target)}`;
		return this.exclusive(command, async () => {
			await this.write(`${command}\r\n`);
			const length = await this.readInteger();
			if (length < 0) throw new IiodError(`reading ${target.attribute}`, length);
			const value = await this.readExact(length + 1);
			return decoder.decode(value.subarray(0, length)).replace(/[\0\s]+$/, '');
		});
	}

	writeAttribute(target: IioAttributeTarget, value: string | number): Promise<void> {
		// libiio sends the terminating NUL, which sysfs parsers accept.
		const bytes = encoder.encode(`${value}\0`);
		const command = `WRITE ${attributeAddress(target)} ${bytes.byteLength}`;
		return this.exclusive(command, async () => {
			// Separate transfers: iiod reads the value only after parsing the command line.
			await this.write(`${command}\r\n`);
			await this.write(bytes);
			const status = await this.readInteger();
			if (status < 0) throw new IiodError(`setting ${target.attribute} to ${value}`, status);
		});
	}

	/**
	 * Send READBUF and queue every USB read of its reply at once, so the transfers
	 * are already waiting while earlier blocks are processed. For a request the
	 * size of the open buffer, iiod writes a length line, the channel mask line,
	 * then the samples in 1 MiB pieces of whole packets with no zero-length packet.
	 * Resolves to the sample data chunks.
	 */
	readbufAhead(deviceId: string, bytes: number, maskWords: number): Promise<Uint8Array[]> {
		if (this.buffered.byteLength) return Promise.reject(new Error('PlutoSDR: unread IIOD reply before READBUF'));
		const sent = this.write(`READBUF ${deviceId} ${bytes}\r\n`);
		const lengthLine = this.receive(LINE_READ_BYTES);
		const maskLine = this.receive(maskWords * 8 + 1);
		const data: Array<Promise<Uint8Array>> = [];
		for (let offset = 0; offset < bytes; offset += MAX_TRANSFER_BYTES)
			data.push(this.receive(Math.min(MAX_TRANSFER_BYTES, bytes - offset)));
		// After a failure the remaining reads settle unobserved.
		for (const pending of [sent, lengthLine, maskLine, ...data]) pending.catch(() => {});
		return this.collectReadbuf(sent, lengthLine, maskLine, data, bytes, maskWords);
	}

	private async collectReadbuf(
		sent: Promise<void>,
		lengthLine: Promise<Uint8Array>,
		maskLine: Promise<Uint8Array>,
		data: Array<Promise<Uint8Array>>,
		bytes: number,
		maskWords: number,
	): Promise<Uint8Array[]> {
		await sent;
		const reply = decoder.decode(await lengthLine);
		const match = /^(-?\d+)\n$/.exec(reply);
		if (!match) throw new Error(`PlutoSDR: unexpected READBUF reply "${reply.trim().slice(0, 40)}"`);
		const length = Number(match[1]);
		if (length < 0) throw new IiodError('READBUF', length);
		if (length !== bytes) throw new Error(`PlutoSDR: READBUF returned ${length} of ${bytes} bytes in one piece`);
		if ((await maskLine).byteLength !== maskWords * 8 + 1) throw new Error('PlutoSDR: malformed READBUF channel mask');
		const chunks = await Promise.all(data);
		if (chunks.reduce((total, chunk) => total + chunk.byteLength, 0) !== bytes) throw new Error('PlutoSDR: short READBUF sample data');
		return chunks;
	}
}
