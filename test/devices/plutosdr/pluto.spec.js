import { describe, expect, it, vi } from 'vitest';
import { PlutoSdrDevice, parseIioRange, plutoBlockSamples } from '@/devices/plutosdr/device';
import { bufferMask, findDevice, parseIioContext, parseSampleFormat } from '@/devices/plutosdr/context';
import { IiodPipe } from '@/devices/plutosdr/iiod';
import { narrowIq } from '@/devices/plutosdr/samples';
import { PlutoThroughput } from '@/devices/plutosdr/throughput';
import { findIiodInterface, openPipe } from '@/devices/plutosdr/usb';
import { detectDevice } from '@/radio/sdr-device';
import { lookupDevice } from '@/radio/device-catalog';
import { createPluto, plutoXml, rawSample } from './mock-iiod.js';

async function connected(options) {
	const fixture = createPluto(options);
	const device = new PlutoSdrDevice();
	await device.open(fixture.usb);
	return { ...fixture, device };
}

function writesTo(state, attribute) {
	return state.writes
		.filter(({ key }) => key.endsWith(` ${attribute}`))
		.map(({ value }) => new TextDecoder().decode(value).replace(/\0$/, ''));
}

async function receive(device, blocks, onBlock = () => {}) {
	const received = [];
	let done;
	const finished = new Promise((resolve) => (done = resolve));
	await device.startRx((data) => {
		received.push(new Int8Array(data.buffer, data.byteOffset, data.byteLength).slice());
		onBlock(received.length);
		if (received.length === blocks) done();
	});
	await finished;
	await device.stopRx();
	return received;
}

const pipeRequest = (request, value) => ({ requestType: 'vendor', recipient: 'interface', request, value, index: 5 });

describe('PlutoSDR device detection', () => {
	it('maps the ADALM-PLUTO USB ID to the plutosdr driver on both threads', () => {
		const usb = { vendorId: 0x0456, productId: 0xb673 };
		expect(lookupDevice(usb)?.type).toBe('plutosdr');
		expect(detectDevice(usb)?.type).toBe('plutosdr');
		// DFU mode exposes no IIO interface.
		expect(lookupDevice({ vendorId: 0x0456, productId: 0xb674 })).toBeNull();
	});

	it('finds the IIO interface by name or, without strings, by its descriptor shape', () => {
		for (const named of [true, false]) {
			const { usb } = createPluto({ named });
			expect(findIiodInterface(usb)).toEqual({
				interfaceNumber: 5,
				pipes: [1, 2, 3].map((n, pipeId) => ({ pipeId, inEndpoint: n, outEndpoint: n, packetSize: 512 })),
			});
		}
	});
});

describe('IIO context XML', () => {
	const context = parseIioContext(plutoXml());

	it('reads context attributes, devices and channels, skipping the DTD', () => {
		expect(context.description).toBe('Linux (none) 5.15.0 "pluto" & friends');
		expect(context.attributes.fw_version).toBe('v0.38');
		expect(context.devices.map((device) => device.name)).toEqual(['ad9361-phy', 'xadc', 'cf-ad9361-lpc']);
		const phy = findDevice(context, 'ad9361-phy');
		expect(phy.attributes).toEqual(['filter_fir_config', 'ensm_mode']);
		expect(phy.channels.find((channel) => channel.id === 'altvoltage0')).toMatchObject({ name: 'RX_LO', output: true, scanIndex: null });
	});

	it('numbers buffer mask bits by scan index, as libiio does', () => {
		const rx = findDevice(context, 'iio:device3');
		expect(rx.channels.map(({ id, maskBit }) => [id, maskBit])).toEqual([
			['voltage1', 1],
			['voltage0', 0],
		]);
		expect(bufferMask(rx, rx.channels)).toBe('00000003');
		expect(bufferMask(rx, [rx.channels[0]])).toBe('00000002');
		expect(parseSampleFormat(rx.channels[0].format)).toEqual({ littleEndian: true, signed: true, bits: 12, storageBits: 16, shift: 0 });
	});

	it('writes multi-word masks most significant word first', () => {
		const device = { channels: Array.from({ length: 40 }, (_, i) => ({ maskBit: i })) };
		expect(bufferMask(device, [device.channels[0], device.channels[33]])).toBe('0000000200000001');
	});
});

describe('PlutoSDR sample conversion', () => {
	it('keeps the top eight of twelve bits, including from unaligned USB data', () => {
		const words = new Int16Array([2047, -2048, 16 + 15, -16, 0, -1]);
		const unaligned = new Uint8Array(words.byteLength + 1);
		unaligned.set(new Uint8Array(words.buffer), 1);
		const out = new Int8Array(words.length + 2);
		narrowIq(unaligned.subarray(1), parseSampleFormat('le:S12/16>>0'), out, 2);
		expect(Array.from(out)).toEqual([0, 0, 127, -128, 1, -1, 0, -1]);
	});

	it('sizes reads to about 20 ms of whole kilo-samples', () => {
		expect(plutoBlockSamples(2400000)).toBe(48128);
		expect(plutoBlockSamples(5000000)).toBe(100352);
		expect(plutoBlockSamples(6000000)).toBe(120832);
		expect(parseIioRange('[325000000 1 3800000000]')).toEqual([325000000, 3800000000]);
		expect(parseIioRange('manual')).toBeNull();
	});
});

describe('PlutoSDR control over iiod', () => {
	it('opens every pipe once and resets its data toggles, without changing the active configuration', async () => {
		const { usb, state, device } = await connected();
		expect(state.controls.slice(0, 11)).toEqual([
			{ claim: 5 },
			pipeRequest(0, 0),
			...[0, 1, 2].flatMap((pipe) => [
				pipeRequest(1, pipe),
				{ clearHalt: 'in', endpoint: pipe + 1 },
				{ clearHalt: 'out', endpoint: pipe + 1 },
			]),
		]);
		expect(state.commands.slice(0, 2).map(({ line }) => line)).toEqual(['VERSION', 'PRINT']);
		expect(await device.getInfo()).toMatchObject({
			name: 'PlutoSDR',
			hardware: 'Analog Devices PlutoSDR Rev.C (Z7010-AD9363A)',
			firmware: 'v0.38',
			serial: '104473b04a0600120c00f5ff2b0ade5a57',
			tuner: 'AD9363A',
			protocol: 'IIOD 0.25 (b6028fd)',
			product: 'PlutoSDR (ADALM-PLUTO)',
		});
		await device.close();
		expect(state.controls.slice(-2)).toEqual([pipeRequest(0, 0), { release: 5 }]);
		expect(usb.configuration.configurationValue).toBe(1);
	});

	it('skips stale reply lines from an interrupted session before the version', async () => {
		const { device } = await connected({ staleLines: ['48128\n', '00000003\n', 'garbage'] });
		expect((await device.getInfo()).protocol).toBe('IIOD 0.25 (b6028fd)');
	});

	it('leaves FIR-only rates before disabling the FIR, then sets rate and analog bandwidth', async () => {
		const { state, device } = await connected();
		await device.setSampleRate(2400000);
		expect(writesTo(state, 'sampling_frequency')).toEqual(['3000000', '2400000']);
		expect(writesTo(state, 'voltage_filter_fir_en')).toEqual(['0']);
		expect(writesTo(state, 'rf_bandwidth')).toEqual(['2400000']);
		// WRITE announces the value length including libiio's terminating NUL.
		expect(state.commands.find(({ line }) => line.includes('rf_bandwidth'))?.line).toBe('WRITE iio:device0 INPUT voltage0 rf_bandwidth 8');

		await device.setSampleRate(5000000);
		expect(writesTo(state, 'voltage_filter_fir_en')).toEqual(['0']);
		expect(writesTo(state, 'sampling_frequency').at(-1)).toBe('5000000');
	});

	it('tunes the RX LO within the range the firmware reports', async () => {
		const { state, device } = await connected({ loRange: '[325000000 1 3800000000]' });
		await device.setFrequency(433920000.4);
		expect(state.attributes.get('iio:device0 OUTPUT altvoltage0 frequency')).toBe('433920000');
		await expect(device.setFrequency(100e6)).rejects.toThrow('PlutoSDR tunes 325-3800 MHz; 100 MHz is out of range');
	});

	it('reports iiod errors with the errno name', async () => {
		const { device } = await connected({ replies: { 'WRITE iio:device0 OUTPUT altvoltage0 frequency 1000000000': -22 } });
		await expect(device.setFrequency(1e9)).rejects.toThrow('PlutoSDR setting frequency to 1000000000 failed: EINVAL (-22)');
	});

	it('applies manual gain within the band range and leaves AGC modes alone', async () => {
		const { state, device } = await connected();
		await device.setGains({ 'Gain Mode': 0, RF: 90 });
		expect(state.attributes.get('iio:device0 INPUT voltage0 gain_control_mode')).toBe('manual');
		expect(writesTo(state, 'hardwaregain')).toEqual(['73']);

		await device.setGain('Gain Mode', 1);
		await device.setGain('RF', 20);
		expect(state.attributes.get('iio:device0 INPUT voltage0 gain_control_mode')).toBe('slow_attack');
		expect(writesTo(state, 'hardwaregain')).toEqual(['73']);

		await device.setGain('Gain Mode', 0);
		expect(writesTo(state, 'hardwaregain')).toEqual(['73', '20']);
	});
});

describe('PlutoSDR streaming', () => {
	it('streams narrowed IQ with replies queued ahead and leaves nothing unread on stop', async () => {
		const { state, device, unread, pendingReads } = await connected();
		await device.setSampleRate(2400000);
		const samples = plutoBlockSamples(2400000);
		const readbufs = () => state.commands.filter(({ line }) => line.startsWith('READBUF')).length;
		const requestedAtDelivery = [];
		const blocks = await receive(device, 3, () => requestedAtDelivery.push(readbufs()));
		expect(state.opened).toEqual({ pipe: 1, device: 'iio:device3', samples, mask: '00000003' });
		expect(state.commands.find(({ line }) => line.startsWith('READBUF'))?.line).toBe(`READBUF iio:device3 ${samples * 4}`);
		// Two more blocks are already requested whenever one is handed to the DSP.
		expect(requestedAtDelivery).toEqual([3, 4, 5]);
		expect(blocks.map((block) => block.length)).toEqual([samples * 2, samples * 2, samples * 2]);
		const all = blocks.flatMap((block) => Array.from(block));
		for (const k of [0, 1, 255, 256, samples + 7]) expect(all.slice(k * 2, k * 2 + 2)).toEqual(rawSample(k).map((v) => v >> 4));
		// The replies requested ahead were consumed before CLOSE; the pipe stays open.
		expect(state.commands.at(-1)).toEqual({ pipe: 1, line: 'CLOSE iio:device3' });
		expect([unread(1), pendingReads(1)]).toEqual([0, 0]);
		expect(state.controls.filter((control) => control.request === 2)).toEqual([]);
		await device.close();
	});

	it('restarts with OPEN and CLOSE only, never resetting endpoints while running', async () => {
		const { state, device } = await connected();
		await device.setSampleRate(2400000);
		const connectControls = state.controls.length;
		await receive(device, 2);
		await device.setSampleRate(5000000);
		await receive(device, 2);
		expect(state.opened).toMatchObject({ pipe: 1, samples: plutoBlockSamples(5000000) });
		expect(state.controls.slice(connectControls)).toEqual([]);
	});

	it('retires a pipe after a failed stream and continues on the spare one', async () => {
		const failed = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { state, device } = await connected({ failReadbuf: [2, 5] });
		await device.setSampleRate(2400000);
		await device.startRx(vi.fn());
		await vi.waitFor(() =>
			expect(failed).toHaveBeenCalledWith('PlutoSDR: receive stream stopped:', 'PlutoSDR READBUF failed: ETIMEDOUT (-110)'),
		);
		await device.stopRx();
		expect(state.controls.at(-1)).toEqual(pipeRequest(2, 1));

		await device.startRx(vi.fn());
		expect(state.opened.pipe).toBe(2);
		await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(2));
		await device.stopRx();
		await expect(device.startRx(vi.fn())).rejects.toThrow('USB streaming failed earlier in this session. Reconnect the PlutoSDR.');
		failed.mockRestore();
	});

	it('rejects READBUF replies split into pieces, which read-ahead cannot frame', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { device } = await connected({ chunkBytes: 8192 });
		await device.setSampleRate(3000000);
		await expect(device.startRx(vi.fn())).rejects.toThrow(`READBUF returned 8192 of ${plutoBlockSamples(3000000) * 4} bytes in one piece`);
		vi.restoreAllMocks();
	});

	it('explains when the receive buffer is busy and keeps the pipe for a retry', async () => {
		const open = `OPEN iio:device3 ${plutoBlockSamples(2400000)} 00000003`;
		const replies = { [open]: -16 };
		const { state, device } = await connected({ replies });
		await device.setSampleRate(2400000);
		await expect(device.startRx(vi.fn())).rejects.toThrow(
			'PlutoSDR could not start receiving (error -16). Close other applications using it.',
		);
		delete replies[open];
		await receive(device, 1);
		expect(state.opened.pipe).toBe(1);
	});

	it('splits sample reads larger than 1 MiB across queued transfers', async () => {
		const { usb, state } = createPluto();
		const usbInterface = findIiodInterface(usb);
		await openPipe(usb, usbInterface, usbInterface.pipes[1]);
		const pipe = new IiodPipe(usb, usbInterface.pipes[1]);
		expect(await pipe.command('OPEN iio:device3 393216 00000003\r\n')).toBe(0);
		const chunks = await pipe.readbufAhead('iio:device3', 393216 * 4, 1);
		expect(chunks.map((chunk) => chunk.byteLength)).toEqual([1 << 20, 1 << 19]);
		expect(state.commands.at(-1)).toEqual({ pipe: 1, line: 'READBUF iio:device3 1572864' });
	});

	it('needs a second pipe for streaming', async () => {
		const device = new PlutoSdrDevice();
		await expect(device.open(createPluto({ pipes: 1 }).usb)).rejects.toThrow('needs at least two pipes');
	});
});

describe('PlutoSDR throughput check', () => {
	function measure(intervalMs) {
		const reports = [];
		const meter = new PlutoThroughput(6000000, (summary, shortfall) => reports.push({ summary, shortfall }), 1000);
		meter.block(120000, 9, 3, 0);
		for (let now = intervalMs; now <= 1000; now += intervalMs) meter.block(120000, now === 100 ? 7.5 : 2, 4, now);
		return reports;
	}

	it('reports the received rate against the configured rate', () => {
		expect(measure(20)).toEqual([
			{
				summary: 'PlutoSDR: received 6.00 of 6.00 MSPS (100.0%); longest wait for USB 7.5 ms, longest processing 4.0 ms',
				shortfall: false,
			},
		]);
	});

	it('flags a shortfall, which means the device dropped samples', () => {
		expect(measure(25)).toEqual([expect.objectContaining({ shortfall: true })]);
		expect(measure(25)[0].summary).toContain('received 4.80 of 6.00 MSPS (80.0%)');
	});
});
