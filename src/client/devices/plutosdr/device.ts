import { errorMessage } from '@/platform/errors';
import { registerDriver } from '@/radio/sdr-device';
import type { GainControl, SdrDevice, SdrDeviceInfo } from '@/radio/types';
import { bufferMask, findChannel, findDevice, parseIioContext, parseSampleFormat } from './context';
import { IiodPipe } from './iiod';
import { isSupportedSampleFormat, narrowIq } from './samples';
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
/** ~20 ms per READBUF, rounded to whole kilo-samples. */
const BLOCK_SECONDS = 0.02;
/** Kernel DMA blocks queued on the device: about 160 ms of slack for browser pauses. */
const KERNEL_BUFFERS = 8;
/** READBUF replies kept queued on USB while a block is processed, so the device never waits for the host. */
const READ_AHEAD_BLOCKS = 2;
const FIRST_BLOCK_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 2000;

/** Parse IIO `_available` ranges such as `[70000000 1 6000000000]`. */
export function parseIioRange(value: string): [number, number] | null {
	const parts = value.replace(/[[\]]/g, ' ').trim().split(/\s+/).map(Number);
	return parts.length === 3 && parts.every(Number.isFinite) ? [parts[0], parts[2]] : null;
}

export function plutoBlockSamples(sampleRate: number): number {
	return Math.max(1024, Math.ceil((sampleRate * BLOCK_SECONDS) / 1024) * 1024);
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
	readonly sampleFormat = 'int8' as const;
	readonly gainControls: GainControl[] = [
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
	private gainMode = 0;
	private gain = 40;
	private sampleRate = this.sampleRates[0];
	private session: PlutoRxSession | null = null;

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

	async close(): Promise<void> {
		await this.stopRx();
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

	async setSampleRate(rate: number): Promise<void> {
		await this.disableFir();
		await this.write(this.rxPath, 'sampling_frequency', Math.round(rate));
		await this.write(this.rxPath, 'rf_bandwidth', Math.round(clamp(rate, RF_BANDWIDTH_RANGE)));
		this.sampleRate = rate;
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

	async setFrequency(freqHz: number): Promise<void> {
		const hz = Math.round(freqHz);
		const [min, max] = this.loRange;
		if (hz < min || hz > max)
			throw new Error(`PlutoSDR tunes ${formatMhz(min)}-${formatMhz(max)} MHz; ${formatMhz(hz)} MHz is out of range`);
		await this.write(this.rxLo, 'frequency', hz);
		// AD936x gain tables, and so the manual gain range, change with the LO band.
		this.gainRange = null;
	}

	async setGain(name: string, value: number): Promise<void> {
		switch (name) {
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

	async setGains(gains: Record<string, number>): Promise<void> {
		if (gains.RF !== undefined) this.gain = gains.RF;
		if (gains['Gain Mode'] !== undefined) await this.setGain('Gain Mode', gains['Gain Mode']);
		else if (this.gainMode === 0) await this.applyManualGain();
	}

	private async applyManualGain(): Promise<void> {
		this.gainRange ??= parseIioRange(await this.read({ device: this.phy, channel: this.rxPath, attribute: 'hardwaregain_available' }));
		const range: [number, number] = this.gainRange ?? [0, 73];
		await this.write(this.rxPath, 'hardwaregain', Math.round(clamp(this.gain, range)));
	}

	async startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		if (this.session) await this.stopRx();
		if (!this.control) throw new Error('PlutoSDR is not connected');
		const pipe = this.streamPipes[0];
		if (!pipe) throw new Error('PlutoSDR: USB streaming failed earlier in this session. Reconnect the PlutoSDR.');
		const session: PlutoRxSession = { pipe, done: Promise.resolve() };
		this.session = session;
		try {
			const samples = plutoBlockSamples(this.sampleRate);
			// Older iiod builds answer unknown commands with -EINVAL; the default of four blocks still works.
			await pipe.command(`SET ${this.rx.id} BUFFERS_COUNT ${KERNEL_BUFFERS}\r\n`);
			const opened = await pipe.command(`OPEN ${this.rx.id} ${samples} ${bufferMask(this.rx, this.rxChannels)}\r\n`);
			if (opened < 0) throw new Error(`PlutoSDR could not start receiving (error ${opened}). Close other applications using it.`);
			let firstBlock!: () => void;
			const started = new Promise<void>((resolve) => (firstBlock = resolve));
			session.done = this.stream(session, samples, callback, () => firstBlock()).catch((error: unknown) => {
				session.error = error instanceof Error ? error : new Error(errorMessage(error));
				if (this.session === session) console.error('PlutoSDR: receive stream stopped:', errorMessage(error));
			});
			await this.awaitFirstBlock(session, started);
		} catch (error) {
			await this.stopRx();
			throw error;
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
			callback(this.narrow(chunks, bytes));
			started();
			throughput.block(samples, processing - waiting, performance.now() - processing);
		}
	}

	private narrow(chunks: Uint8Array[], bytes: number): Int8Array {
		const iq = new Int8Array(bytes / (this.rxFormat.storageBits / 8));
		let offset = 0;
		for (const chunk of chunks) {
			narrowIq(chunk, this.rxFormat, iq, offset >> 1);
			offset += chunk.byteLength;
		}
		return iq;
	}

	async stopRx(): Promise<void> {
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
