import { errorMessage } from '@/platform/errors';
import { iqPrecisionControl, selectedIqBits } from '@/radio/iq/format';
import { receiveTransferSize } from '@/radio/receive-transfer';
import { registerDriver } from '@/radio/sdr-device';
import type { GainControl, SdrDevice, SdrDeviceInfo } from '@/radio/types';
import { bufferMask, findChannel, findDevice, parseIioContext, parseSampleFormat } from './context';
import { IiodPipe } from './iiod';
import { convertIq, isSupportedSampleFormat } from './samples';
import { PlutoThroughput } from './throughput';
import type { IioAttributeTarget, IioChannel, IioContext, IioDevice, IioSampleFormat, IiodUsbInterface, PlutoRxSession } from './types';
import { closePipe, findIiodInterface, openPipe, resetPipes } from './usb';

/*
PlutoSDR (ADALM-PLUTO) and compatible AD936x boards over WebUSB.

Speaks the libiio USB protocol to the iiod daemon in the device firmware:
pipe 0 carries attribute reads and writes for ad9361-phy, and another pipe
streams cf-ad9361-lpc buffers so retuning never waits behind samples. Every
pipe is opened once at connect; streams start and stop with OPEN and CLOSE.
Protocol reference: libiio and libad9361 (https://github.com/analogdevicesinc).
*/

const PLUTO_FILTERS: USBDeviceFilter[] = [{ vendorId: 0x0456, productId: 0xb673 }];
const GAIN_MODES = ['manual', 'slow_attack', 'fast_attack', 'hybrid'];
/** Lowest AD936x baseband rate without the programmable decimating FIR. */
const MIN_RATE_WITHOUT_FIR = 25e6 / 12;
const RF_BANDWIDTH_RANGE: [number, number] = [200e3, 56e6];
/** AD9364 range; AD9363 firmware reports 325-3800 MHz through frequency_available. */
const DEFAULT_LO_RANGE: [number, number] = [70e6, 6e9];
/** One USB transfer per READBUF at the listed rates. */
const MAX_BLOCK_BYTES = 1 << 20;
/** I and Q travel as 16-bit words. */
const WIRE_BYTES_PER_SAMPLE = 4;
/** Kernel DMA blocks queued on the device: about 128 ms of slack for browser pauses. */
const KERNEL_BUFFERS = 16;
/** READBUF replies kept queued on USB while a block is processed, so the device never waits for the host. */
const READ_AHEAD_BLOCKS = 4;
const FIRST_BLOCK_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 2000;

/** Parse IIO `_available` ranges such as `[70000000 1 6000000000]`. */
export function parseIioRange(value: string): [number, number] | null {
	const parts = value.replace(/[[\]]/g, ' ').trim().split(/\s+/).map(Number);
	return parts.length === 3 && parts.every(Number.isFinite) ? [parts[0], parts[2]] : null;
}

/** Samples per READBUF, which is also the kernel buffer size: about 8 ms, like other receivers' reads. */
export function plutoBlockSamples(sampleRate: number): number {
	return receiveTransferSize(sampleRate, MAX_BLOCK_BYTES, WIRE_BYTES_PER_SAMPLE) / WIRE_BYTES_PER_SAMPLE;
}

function clamp(value: number, [min, max]: [number, number]): number {
	return Math.min(max, Math.max(min, value));
}

function formatMhz(hz: number): string {
	return String(+(hz / 1e6).toFixed(3));
}

export class PlutoSdrDevice implements SdrDevice {
	readonly deviceType = 'plutosdr';
	// 2.4 MSPS and above run without a custom FIR; USB 2.0 carries 16-bit IQ continuously to about 6 MSPS.
	readonly sampleRates = [2400000, 3000000, 4000000, 5000000, 6000000];
	readonly nativeIqBits = 12;
	private iqBits: 8 | 12 | 16 = 12;
	get sampleFormat() {
		return this.iqBits === 8 ? ('int8' as const) : ('int16' as const);
	}
	readonly gainControls: GainControl[] = [
		iqPrecisionControl(12),
		{ name: 'Gain Mode', min: 0, max: 3, step: 1, default: 0, labels: ['Manual', 'Slow AGC', 'Fast AGC', 'Hybrid AGC'], type: 'select' },
		{ name: 'RF', min: 0, max: 73, step: 1, default: 40, type: 'slider' },
	];

	private usb?: USBDevice;
	private usbInterface?: IiodUsbInterface;
	private control?: IiodPipe;
	/** Spare stream pipes; one whose reply state is unknown after an error is retired. */
	private streamPipes: IiodPipe[] = [];
	private context?: IioContext;
	private iiodVersion = '';
	private phy!: IioDevice;
	private rx!: IioDevice;
	private rxChannels: IioChannel[] = [];
	private rxFormat!: IioSampleFormat;
	private loRange = DEFAULT_LO_RANGE;
	private gainRange: [number, number] | null = null;
	/** Null until a Gain Mode is set: the firmware's own mode stays in effect until then. */
	private gainMode: number | null = null;
	private gain = 40;
	private sampleRate = this.sampleRates[0];
	private session: PlutoRxSession | null = null;
	private operations: Promise<unknown> = Promise.resolve();

	/** Tunable LO range in Hz, as the firmware reports it once open. */
	get frequencyRange(): [number, number] {
		return this.loRange;
	}

	/**
	 * Run device operations one at a time. Each spans several IIOD commands, so a retune
	 * could otherwise interleave with a gain update, or a stop with a pending OPEN.
	 */
	private serialized<T>(task: () => Promise<T>): Promise<T> {
		const run = this.operations.then(task);
		this.operations = run.catch(() => {});
		return run;
	}

	async open(device: USBDevice): Promise<void> {
		this.usb = device;
		await device.open();
		// Other interfaces (network, storage, console) may be bound to OS drivers: keep the active configuration.
		if (!device.configuration) await device.selectConfiguration(1);
		const usbInterface = findIiodInterface(device);
		if (!usbInterface) throw new Error('PlutoSDR: no IIO USB interface found. Update the device firmware and reconnect it.');
		if (usbInterface.pipes.length < 2) throw new Error('PlutoSDR: the IIO USB interface needs at least two pipes');
		await device.claimInterface(usbInterface.interfaceNumber);
		this.usbInterface = usbInterface;
		await resetPipes(device, usbInterface);
		for (const pipe of usbInterface.pipes) await openPipe(device, usbInterface, pipe);
		[this.control, ...this.streamPipes] = usbInterface.pipes.map((pipe) => new IiodPipe(device, pipe));
		this.iiodVersion = await this.control.version();
		this.context = parseIioContext(await this.control.printContext());
		this.bindReceiver(this.context);
		const range = parseIioRange(
			await this.read({ device: this.phy, channel: this.rxLo, attribute: 'frequency_available' }).catch(() => ''),
		);
		if (range) this.loRange = range;
	}

	private bindReceiver(context: IioContext): void {
		const phy = findDevice(context, 'ad9361-phy');
		const rx = findDevice(context, 'cf-ad9361-lpc');
		if (!phy || !rx) throw new Error('PlutoSDR: this IIO device has no AD936x receiver (ad9361-phy and cf-ad9361-lpc)');
		const channels = rx.channels
			.filter((channel) => !channel.output && channel.scanIndex !== null)
			.sort((a, b) => a.maskBit - b.maskBit)
			.slice(0, 2);
		const format = parseSampleFormat(channels[0]?.format);
		if (channels.length < 2 || !isSupportedSampleFormat(format) || channels[1].format !== channels[0].format)
			throw new Error(`PlutoSDR: unsupported receive sample format ${channels[0]?.format ?? '(none)'}`);
		if (!findChannel(phy, 'voltage0', false) || !findChannel(phy, 'altvoltage0', true))
			throw new Error('PlutoSDR: ad9361-phy lacks receive gain or LO controls');
		this.phy = phy;
		this.rx = rx;
		this.rxChannels = channels;
		this.rxFormat = format;
	}

	private get rxPath(): IioChannel {
		return findChannel(this.phy, 'voltage0', false)!;
	}

	private get rxLo(): IioChannel {
		return findChannel(this.phy, 'altvoltage0', true)!;
	}

	private get pipe(): IiodPipe {
		if (!this.control) throw new Error('PlutoSDR is not connected');
		return this.control;
	}

	private read(target: IioAttributeTarget): Promise<string> {
		return this.pipe.readAttribute(target);
	}

	private write(channel: IioChannel, attribute: string, value: string | number): Promise<void> {
		return this.pipe.writeAttribute({ device: this.phy, channel, attribute }, value);
	}

	close(): Promise<void> {
		return this.serialized(() => this.shutDown());
	}

	private async shutDown(): Promise<void> {
		await this.stop();
		const { usb, usbInterface } = this;
		if (usb && usbInterface) {
			await resetPipes(usb, usbInterface).catch(() => {});
			await usb.releaseInterface(usbInterface.interfaceNumber).catch(() => {});
		}
		this.control = undefined;
		this.streamPipes = [];
		try {
			await usb?.close();
		} catch {
			/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
		}
	}

	getInfo(): Promise<SdrDeviceInfo> {
		const attributes = this.context?.attributes ?? {};
		const model = attributes.hw_model;
		const name = !model || /plutosdr/i.test(model) ? 'PlutoSDR' : model.replace(/\s*\(.*$/, '');
		const chip = attributes['ad9361-phy,model'] ?? /\b(AD936\d\w*)\b/i.exec(model ?? '')?.[1];
		return Promise.resolve({
			name,
			hardware: model,
			firmware: attributes.fw_version,
			serial: attributes.hw_serial,
			usbSerial: this.usb?.serialNumber,
			manufacturer: this.usb?.manufacturerName,
			product: this.usb?.productName,
			tuner: chip?.toUpperCase(),
			protocol: this.iiodVersion ? `IIOD ${this.iiodVersion}` : undefined,
		});
	}

	setSampleRate(rate: number): Promise<void> {
		return this.serialized(async () => {
			await this.disableFir();
			await this.write(this.rxPath, 'sampling_frequency', Math.round(rate));
			await this.write(this.rxPath, 'rf_bandwidth', Math.round(clamp(rate, RF_BANDWIDTH_RANGE)));
			this.sampleRate = rate;
		});
	}

	/** A FIR left by other software constrains rates and shapes the passband; the listed rates need none. */
	private async disableFir(): Promise<void> {
		const firChannel = findChannel(this.phy, 'out', false);
		const target: IioAttributeTarget | null = this.phy.attributes.includes('in_out_voltage_filter_fir_en')
			? { device: this.phy, attribute: 'in_out_voltage_filter_fir_en' }
			: firChannel?.attributes.includes('voltage_filter_fir_en')
				? { device: this.phy, channel: firChannel, attribute: 'voltage_filter_fir_en' }
				: null;
		if (!target || (await this.read(target)) === '0') return;
		// As libad9361 does: leave FIR-only rates before disabling the filter.
		const current = Number(await this.read({ device: this.phy, channel: this.rxPath, attribute: 'sampling_frequency' }));
		if (current <= MIN_RATE_WITHOUT_FIR) await this.write(this.rxPath, 'sampling_frequency', 3000000);
		await this.pipe.writeAttribute(target, 0);
	}

	setFrequency(freqHz: number): Promise<void> {
		return this.serialized(async () => {
			const hz = Math.round(freqHz);
			const [min, max] = this.loRange;
			if (hz < min || hz > max)
				throw new Error(`PlutoSDR tunes ${formatMhz(min)}-${formatMhz(max)} MHz; ${formatMhz(hz)} MHz is out of range`);
			await this.write(this.rxLo, 'frequency', hz);
			// AD936x gain tables, and so the manual gain range, change with the LO band. The firmware
			// keeps the current gain clamped to the new band's limit, so reapply the requested gain.
			this.gainRange = null;
			if (this.gainMode === 0) await this.applyManualGain();
		});
	}

	setGain(name: string, value: number): Promise<void> {
		return this.serialized(() => this.applyGain(name, value));
	}

	private async applyGain(name: string, value: number): Promise<void> {
		switch (name) {
			case 'IQ Precision':
				this.setIqPrecision(value);
				break;
			case 'Gain Mode': {
				const mode = Math.round(clamp(value, [0, GAIN_MODES.length - 1]));
				await this.write(this.rxPath, 'gain_control_mode', GAIN_MODES[mode]);
				this.gainMode = mode;
				if (mode === 0) await this.applyManualGain();
				break;
			}
			case 'RF':
				this.gain = value;
				if (this.gainMode === 0) await this.applyManualGain();
				break;
			default:
				console.warn(`PlutoSDR: unknown gain "${name}"`);
		}
	}

	setGains(gains: Record<string, number>): Promise<void> {
		return this.serialized(async () => {
			if (gains['IQ Precision'] !== undefined) this.setIqPrecision(gains['IQ Precision']);
			if (gains.RF !== undefined) this.gain = gains.RF;
			if (gains['Gain Mode'] !== undefined) await this.applyGain('Gain Mode', gains['Gain Mode']);
			else if (this.gainMode === 0) await this.applyManualGain();
		});
	}

	/** Host-side only: USB always carries 16-bit words, and the DSP format is fixed while receiving. */
	private setIqPrecision(selection: number): void {
		const bits = selectedIqBits(12, selection);
		if (this.session && bits !== this.iqBits) throw new Error('Stop reception before changing IQ precision');
		this.iqBits = bits;
	}

	private async applyManualGain(): Promise<void> {
		this.gainRange ??= parseIioRange(await this.read({ device: this.phy, channel: this.rxPath, attribute: 'hardwaregain_available' }));
		const range: [number, number] = this.gainRange ?? [0, 73];
		await this.write(this.rxPath, 'hardwaregain', Math.round(clamp(this.gain, range)));
	}

	startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		return this.serialized(() => this.start(callback));
	}

	stopRx(): Promise<void> {
		return this.serialized(() => this.stop());
	}

	private async start(callback: (data: ArrayBufferView) => void): Promise<void> {
		if (this.session) await this.stop();
		if (!this.control) throw new Error('PlutoSDR is not connected');
		const pipe = this.streamPipes[0];
		if (!pipe) throw new Error('PlutoSDR: USB streaming failed earlier in this session. Reconnect the PlutoSDR.');
		const session: PlutoRxSession = { pipe, done: Promise.resolve() };
		this.session = session;
		try {
			const samples = plutoBlockSamples(this.sampleRate);
			await this.openBuffer(pipe, samples);
			let firstBlock!: () => void;
			const started = new Promise<void>((resolve) => (firstBlock = resolve));
			session.done = this.receive(session, samples, callback, () => firstBlock());
			await this.awaitFirstBlock(session, started);
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	private async openBuffer(pipe: IiodPipe, samples: number): Promise<void> {
		// Older iiod builds answer unknown commands with -EINVAL; the default of four blocks still works.
		await pipe.command(`SET ${this.rx.id} BUFFERS_COUNT ${KERNEL_BUFFERS}\r\n`);
		const opened = await pipe.command(`OPEN ${this.rx.id} ${samples} ${bufferMask(this.rx, this.rxChannels)}\r\n`);
		if (opened < 0) throw new Error(`PlutoSDR could not start receiving (error ${opened}). Close other applications using it.`);
	}

	/**
	 * Stream until stopped. startRx has resolved once samples flow, so a pipe that fails
	 * after delivering them is retired and reception resumes on a spare. Earlier failures
	 * reject startRx instead: they are often not specific to the pipe.
	 */
	private async receive(
		session: PlutoRxSession,
		samples: number,
		callback: (data: ArrayBufferView) => void,
		started: () => void,
	): Promise<void> {
		let delivered = false;
		while (this.session === session) {
			try {
				await this.stream(session, samples, callback, () => {
					delivered = true;
					started();
				});
				return;
			} catch (error) {
				session.error = error instanceof Error ? error : new Error(errorMessage(error));
				if (this.session !== session) return;
				const spare = delivered ? this.streamPipes.find((pipe) => pipe !== session.pipe) : undefined;
				if (!spare || !(await this.failOver(session, spare, samples))) {
					console.error('PlutoSDR: receive stream stopped:', errorMessage(session.error));
					return;
				}
			}
		}
	}

	/** Retire the session's failed pipe and reopen the receive buffer on `spare`. */
	private async failOver(session: PlutoRxSession, spare: IiodPipe, samples: number): Promise<boolean> {
		console.warn(`PlutoSDR: receive stream failed (${errorMessage(session.error)}); resuming on a spare USB pipe`);
		await this.retire(session.pipe);
		session.pipe = spare;
		try {
			await this.openBuffer(spare, samples);
			session.error = undefined;
			return true;
		} catch (error) {
			session.error = error instanceof Error ? error : new Error(errorMessage(error));
			return false;
		}
	}

	private async awaitFirstBlock(session: PlutoRxSession, started: Promise<void>): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const failed = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error('PlutoSDR returned no samples. Reconnect it and close other applications using it.')),
				FIRST_BLOCK_TIMEOUT_MS,
			);
			void session.done.then(() => reject(session.error ?? new Error('PlutoSDR stopped before returning samples')));
		});
		try {
			await Promise.race([started, failed]);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * READ_AHEAD_BLOCKS replies stay queued on USB while each block is processed,
	 * so transfers overlap the DSP. Stopping consumes the replies already requested.
	 */
	private async stream(
		session: PlutoRxSession,
		samples: number,
		callback: (data: ArrayBufferView) => void,
		started: () => void,
	): Promise<void> {
		const { pipe } = session;
		const bytes = samples * this.rxChannels.length * (this.rxFormat.storageBits / 8);
		const maskWords = Math.ceil(this.rx.channels.length / 32);
		const throughput = new PlutoThroughput(this.sampleRate, (summary, shortfall) => {
			if (shortfall) console.warn(`${summary}. Samples were dropped; try a lower sample rate.`);
			else if (import.meta.env.DEV) console.info(summary);
		});
		const queue: Array<Promise<Uint8Array[]>> = [];
		const request = () => {
			const reply = pipe.readbufAhead(this.rx.id, bytes, maskWords);
			reply.catch(() => {});
			queue.push(reply);
		};
		for (let i = 0; i < READ_AHEAD_BLOCKS; i++) request();
		while (queue.length) {
			const waiting = performance.now();
			const chunks = await queue.shift()!;
			if (this.session !== session) continue;
			request();
			const processing = performance.now();
			callback(this.convert(chunks, bytes));
			started();
			throughput.block(samples, processing - waiting, performance.now() - processing);
		}
	}

	private convert(chunks: Uint8Array[], bytes: number): Int8Array | Int16Array {
		const IqArray = this.iqBits === 8 ? Int8Array : Int16Array;
		const iq = new IqArray(bytes / (this.rxFormat.storageBits / 8));
		let offset = 0;
		for (const chunk of chunks) {
			convertIq(chunk, this.rxFormat, iq, offset >> 1);
			offset += chunk.byteLength;
		}
		return iq;
	}

	private async stop(): Promise<void> {
		const session = this.session;
		if (!session) return;
		this.session = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const settled = await Promise.race([
			session.done.then(() => true),
			new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS))),
		]);
		clearTimeout(timer);
		const closed =
			settled &&
			!session.error &&
			(await session.pipe.command(`CLOSE ${this.rx.id}\r\n`).then(
				() => true,
				() => false,
			));
		if (!closed) await this.retire(session.pipe);
	}

	/**
	 * After a failed stream, reads may still be queued on the pipe, so it cannot be
	 * trusted again. Closing it on the device also releases the receive buffer.
	 * Resetting its endpoints instead would disturb other pipes on macOS.
	 */
	private async retire(pipe: IiodPipe): Promise<void> {
		this.streamPipes = this.streamPipes.filter((candidate) => candidate !== pipe);
		const { usb, usbInterface } = this;
		if (usb && usbInterface) await closePipe(usb, usbInterface, pipe.endpoints.pipeId).catch(() => {});
	}
}

registerDriver({
	type: 'plutosdr',
	name: 'PlutoSDR',
	filters: PLUTO_FILTERS,
	create: () => new PlutoSdrDevice(),
});
