/*
Original: https://github.com/mossmann/hackrf/blob/master/host/libhackrf/src/hackrf.c
Copyright (c) 2012, Jared Boone <jared@sharebrained.com>
Copyright (c) 2013, Benjamin Vernoux <titanmkd@gmail.com>
Copyright (c) 2013, Michael Ossmann <mike@ossmann.com>

This JavaScript impl:
Copyright (c) 2026, jLynx <https://github.com/jLynx>
Copyright (c) 2019, cho45 <cho45@lowreal.net>

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
	Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
	Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the
	documentation and/or other materials provided with the distribution.
	Neither the name of Great Scott Gadgets nor the names of its contributors may be used to endorse or promote products derived from this software
	without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

interface PartIdSerialNo {
	partId: [number, number];
	serialNo: [number, number, number, number];
}

type RxCallback = (data: Uint8Array) => void;

class HackRF {
	static BOARD_ID_NAME: ReadonlyMap<number, string> = Object.freeze(new Map<number, string>([
		[0, "JellyBean"],
		[1, "JawBreaker"],
		[2, "HackRF One"],
		[3, "rad1o"],
		[4, "HackRF One r9"],
		[5, "HackRF Pro"],
		[0xFE, "Undetected"],
		[0xFF, "Invalid Board ID"],
	]));

	static BOARD_REV_UNRECOGNIZED: number = 0xfe;
	static BOARD_REV_UNDETECTED: number = 0xff;
	static HACKRF_BOARD_REV_GSG: number = 0x80;

	static HACKRF_PLATFORM_JAWBREAKER: number = (1 << 0);
	static HACKRF_PLATFORM_HACKRF1_OG: number = (1 << 1);
	static HACKRF_PLATFORM_RAD1O: number     = (1 << 2);
	static HACKRF_PLATFORM_HACKRF1_R9: number = (1 << 3);
	static HACKRF_PLATFORM_PRALINE: number   = (1 << 4);
	static BOARD_REV_NAME: ReadonlyMap<number, string> = Object.freeze(new Map<number, string>([
		// HackRF One revisions (non-GSG and GSG share the same name)
		[0,    "older than r6"],
		[1,    "r6"],  [0x81, "r6"],
		[2,    "r7"],  [0x82, "r7"],
		[3,    "r8"],  [0x83, "r8"],
		[4,    "r9"],  [0x84, "r9"],
		[5,    "r10"], [0x85, "r10"],
		// HackRF Pro (Praline) revisions
		[6,    "r0.1"], [0x86, "r0.1"],
		[7,    "r0.2"], [0x87, "r0.2"],
		[8,    "r0.3"], [0x88, "r0.3"],
		[9,    "r1.0"], [0x89, "r1.0"],
		[10,   "r1.1"], [0x8a, "r1.1"],
		[11,   "r1.2"], [0x8b, "r1.2"],
		[HackRF.BOARD_REV_UNRECOGNIZED, "unrecognized"],
		[HackRF.BOARD_REV_UNDETECTED,   "undetected"],
	]));

	static USB_CONFIG_STANDARD: number = 0x1;
	static TRANSFER_BUFFER_SIZE: number = 262144;

	static SAMPLES_PER_BLOCK: number = 8192;
	static BYTES_PER_BLOCK: number = 16384;
	static MAX_SWEEP_RANGES: number = 10;

	static SWEEP_STYLE_LINEAR: number = 0;
	static SWEEP_STYLE_INTERLEAVED: number = 1;

	static HACKRF_VENDOR_REQUEST_SET_TRANSCEIVER_MODE: number = 1;
	static HACKRF_VENDOR_REQUEST_MAX2837_WRITE: number = 2;
	static HACKRF_VENDOR_REQUEST_MAX2837_READ: number = 3;
	static HACKRF_VENDOR_REQUEST_SI5351C_WRITE: number = 4;
	static HACKRF_VENDOR_REQUEST_SI5351C_READ: number = 5;
	static HACKRF_VENDOR_REQUEST_SAMPLE_RATE_SET: number = 6;
	static HACKRF_VENDOR_REQUEST_BASEBAND_FILTER_BANDWIDTH_SET: number = 7;
	static HACKRF_VENDOR_REQUEST_RFFC5071_WRITE: number = 8;
	static HACKRF_VENDOR_REQUEST_RFFC5071_READ: number = 9;
	static HACKRF_VENDOR_REQUEST_SPIFLASH_ERASE: number = 10;
	static HACKRF_VENDOR_REQUEST_SPIFLASH_WRITE: number = 11;
	static HACKRF_VENDOR_REQUEST_SPIFLASH_READ: number = 12;
	static HACKRF_VENDOR_REQUEST_BOARD_ID_READ: number = 14;
	static HACKRF_VENDOR_REQUEST_VERSION_STRING_READ: number = 15;
	static HACKRF_VENDOR_REQUEST_SET_FREQ: number = 16;
	static HACKRF_VENDOR_REQUEST_AMP_ENABLE: number = 17;
	static HACKRF_VENDOR_REQUEST_BOARD_PARTID_SERIALNO_READ: number = 18;
	static HACKRF_VENDOR_REQUEST_SET_LNA_GAIN: number = 19;
	static HACKRF_VENDOR_REQUEST_SET_VGA_GAIN: number = 20;
	static HACKRF_VENDOR_REQUEST_SET_TXVGA_GAIN: number = 21;
	static HACKRF_VENDOR_REQUEST_ANTENNA_ENABLE: number = 23;
	static HACKRF_VENDOR_REQUEST_SET_FREQ_EXPLICIT: number = 24;
	static HACKRF_VENDOR_REQUEST_USB_WCID_VENDOR_REQ: number = 25;
	static HACKRF_VENDOR_REQUEST_INIT_SWEEP: number = 26;
	static HACKRF_VENDOR_REQUEST_OPERACAKE_GET_BOARDS: number = 27;
	static HACKRF_VENDOR_REQUEST_OPERACAKE_SET_PORTS: number = 28;
	static HACKRF_VENDOR_REQUEST_SET_HW_SYNC_MODE: number = 29;
	static HACKRF_VENDOR_REQUEST_RESET: number = 30;
	static HACKRF_VENDOR_REQUEST_OPERACAKE_SET_RANGES: number = 31;
	static HACKRF_VENDOR_REQUEST_CLKOUT_ENABLE: number = 32;
	static HACKRF_VENDOR_REQUEST_SPIFLASH_STATUS: number = 33;
	static HACKRF_VENDOR_REQUEST_SPIFLASH_CLEAR_STATUS: number = 34;
	static HACKRF_VENDOR_REQUEST_OPERACAKE_GPIO_TEST: number = 35;
	static HACKRF_VENDOR_REQUEST_CPLD_CHECKSUM: number = 36;
	static HACKRF_VENDOR_REQUEST_UI_ENABLE: number = 37;
	static HACKRF_VENDOR_REQUEST_OPERACAKE_SET_MODE: number = 38;
	static HACKRF_VENDOR_REQUEST_OPERACAKE_GET_MODE: number = 39;
	static HACKRF_VENDOR_REQUEST_OPERACAKE_SET_DWELL_TIMES: number = 40;
	static HACKRF_VENDOR_REQUEST_GET_M0_STATE: number = 41;
	static HACKRF_VENDOR_REQUEST_SET_TX_UNDERRUN_LIMIT: number = 42;
	static HACKRF_VENDOR_REQUEST_SET_RX_OVERRUN_LIMIT: number = 43;
	static HACKRF_VENDOR_REQUEST_GET_CLKIN_STATUS: number = 44;
	static HACKRF_VENDOR_REQUEST_BOARD_REV_READ: number = 45;
	static HACKRF_VENDOR_REQUEST_SUPPORTED_PLATFORM_READ: number = 46;
	static HACKRF_VENDOR_REQUEST_SET_LEDS: number = 47;
	static HACKRF_VENDOR_REQUEST_SET_USER_BIAS_T_OPTS: number = 48;

	static HACKRF_TRANSCEIVER_MODE_OFF: number = 0;
	static HACKRF_TRANSCEIVER_MODE_RECEIVE: number = 1;
	static HACKRF_TRANSCEIVER_MODE_TRANSMIT: number = 2;
	static HACKRF_TRANSCEIVER_MODE_SS: number = 3;
	static TRANSCEIVER_MODE_CPLD_UPDATE: number = 4;
	static TRANSCEIVER_MODE_RX_SWEEP: number = 5;

	static HACKRF_HW_SYNC_MODE_OFF: number = 0;
	static HACKRF_HW_SYNC_MODE_ON: number = 1;

	static MAX2837_FT: number[] = [
		1750000,
		2500000,
		3500000,
		5000000,
		5500000,
		6000000,
		7000000,
		8000000,
		9000000,
		10000000,
		12000000,
		14000000,
		15000000,
		20000000,
		24000000,
		28000000
	];

	device!: USBDevice;
	rxRunning: Promise<void>[] | null = null;

	static computeBasebandFilterBw(bandwidthHz: number): number {
		const i = HackRF.MAX2837_FT.findIndex((e) => e >= bandwidthHz);
		if (i === -1) {
			throw "invalid bandwidthHz " + bandwidthHz;
		}
		if (i > 0) {
			return HackRF.MAX2837_FT[i - 1];
		} else {
			return HackRF.MAX2837_FT[0];
		}
	}

	constructor() {
	}

	static async requestDevice(filters?: USBDeviceFilter[]): Promise<USBDevice | undefined> {
		const device = await navigator.usb.requestDevice({
			filters: filters || [
				// see: https://github.com/mossmann/hackrf/blob/master/host/libhackrf/53-hackrf.rules
				{ vendorId: 0x1d50, productId: 0x604b },
				{ vendorId: 0x1d50, productId: 0x6089 },
				{ vendorId: 0x1d50, productId: 0xcc15 },
				{ vendorId: 0x1fc9, productId: 0x000c },
			]
		}).catch((_e: unknown) => null);
		if (!device) {
			console.warn('HackRF: no device matched');
			return;
		}
		return device;
	}

	async open(device: USBDevice): Promise<void> {
		if (this.device) {
			await this.close();
			await this.exit();
		}

		await device.open();
		await device.selectConfiguration(HackRF.USB_CONFIG_STANDARD);
		await device.claimInterface(0);

		this.device = device;
	}

	async readBoardId(): Promise<number> {
		const result = await this.device.controlTransferIn({
			requestType: "vendor",
			recipient: "device",
			request: HackRF.HACKRF_VENDOR_REQUEST_BOARD_ID_READ,
			value: 0,
			index: 0,
		}, 1);
		if (result.status !== 'ok') {
			throw 'failed to readBoardId';
		}
		return result.data!.getUint8(0);
	}

	async readVersionString(): Promise<string> {
		const result = await this.device.controlTransferIn({
			requestType: "vendor",
			recipient: "device",
			request: HackRF.HACKRF_VENDOR_REQUEST_VERSION_STRING_READ,
			value: 0,
			index: 0,
		}, 255);
		if (result.status !== 'ok') {
			throw 'failed to readVersionString';
		}
		return String.fromCharCode(...new Uint8Array(result.data!.buffer));
	}

	async readApiVersion(): Promise<[number, number, number]> {
		return [this.device.deviceVersionMajor, this.device.deviceVersionMinor, this.device.deviceVersionSubminor];
	}

	async usbApiRequired(v: number): Promise<void> {
		const [major, minor, subminor] = await this.readApiVersion();
		const bcdVersion = (major << 8) | (minor << 4) | subminor;
		if (bcdVersion < v) {
			throw `USB API version ${v.toString(16)} required, but ${bcdVersion.toString(16)} found`;
		}
	}

	async readPartIdSerialNo(): Promise<PartIdSerialNo> {
		const result = await this.device.controlTransferIn({
			requestType: "vendor",
			recipient: "device",
			request: HackRF.HACKRF_VENDOR_REQUEST_BOARD_PARTID_SERIALNO_READ,
			value: 0,
			index: 0,
		}, 24);
		if (result.status !== 'ok') {
			throw 'failed to readPartIdSerialNo';
		}
		/*
		 *
		 * https://github.com/mossmann/hackrf/blob/master/host/libhackrf/src/hackrf.h#L119
		 * typedef struct {
		 *   uint32_t part_id[2];
		 *   uint32_t serial_no[4];
		 * } read_partid_serialno_t;
		 *
		 * (32/8) * 2 + (32/8) * 4 = 24
		 */

		const partId: [number, number] = [
			result.data!.getUint32(0, true),
			result.data!.getUint32(1 * 4, true)
		];

		const serialNo: [number, number, number, number] = [
			result.data!.getUint32(2 * 4, true),
			result.data!.getUint32(3 * 4, true),
			result.data!.getUint32(4 * 4, true),
			result.data!.getUint32(5 * 4, true)
		];

		return { partId, serialNo };
	}

	async setTransceiverMode(mode: number): Promise<void> {
		const result = await this.device.controlTransferOut({
			requestType: "vendor",
			recipient: "device",
			request: HackRF.HACKRF_VENDOR_REQUEST_SET_TRANSCEIVER_MODE,
			value: mode,
			index: 0,
		});
		if (result.status !== 'ok') {
			throw 'failed to setTransceiverMode';
		}
	}

	async setSampleRateManual(freqHz: number, divider: number): Promise<void> {
		/*
		 * typedef struct {
		 *   uint32_t freq_hz;
		 *   uint32_t divider;
		 * } set_fracrate_params_t;
		 */
		const params = new DataView(new ArrayBuffer(8));
		params.setUint32(0, freqHz, true);
		params.setUint32(4, divider, true);

		const result = await this.device.controlTransferOut({
			requestType: "vendor",
			recipient: "device",
			request: HackRF.HACKRF_VENDOR_REQUEST_SAMPLE_RATE_SET,
			value: 0,
			index: 0,
		}, params.buffer);
		if (result.status !== 'ok') {
			throw 'failed to setTransceiverMode';
		}

		this.setBasebandFilterBandwidth(HackRF.computeBasebandFilterBw(0.75 * freqHz / divider));
	}

	async setBasebandFilterBandwidth(bandwidthHz: number): Promise<void> {
		const result = await this.device.controlTransferOut({
			requestType: "vendor",
			recipient: "device",
			request: HackRF.HACKRF_VENDOR_REQUEST_BASEBAND_FILTER_BANDWIDTH_SET,
			value: bandwidthHz & 0xffff,
			index: (bandwidthHz >> 16) & 0xffff,
		});
		if (result.status !== 'ok') {
			throw 'failed to setTransceiverMode';
		}
	}

	async setVgaGain(value: number): Promise<void> {
		if (value > 62) {
			throw "gain must be <= 62";
		}
		value &= ~0x01;
		const result = await this.device.controlTransferIn({
			requestType: "vendor",
			recipient: "device",
			request: HackRF.HACKRF_VENDOR_REQUEST_SET_VGA_GAIN,
			value: 0,
			index: value,
		}, 1);
		if (result.status !== 'ok' || !result.data!.getUint8(0)) {
			throw 'failed to setVgaGain';
		}
	}

	async setLnaGain(value: number): Promise<void> {
		if (value > 40) {
			throw "gain must be <= 40";
		}
		value &= ~0x07;
		const result = await this.device.controlTransferIn({
			requestType: "vendor",
			recipient: "device",
			request: HackRF.HACKRF_VENDOR_REQUEST_SET_LNA_GAIN,
			value: 0,
			index: value,
		}, 1);
		if (result.status !== 'ok' || !result.data!.getUint8(0)) {
			throw 'failed to setLnaGain';
		}
	}

	async setAmpEnable(value: boolean): Promise<void> {
		const result = await this.device.controlTransferOut({
			requestType: "vendor",
			recipient: "device",
			request: HackRF.HACKRF_VENDOR_REQUEST_AMP_ENABLE,
			value: value ? 1 : 0,
			index: 0,
		});
		if (result.status !== 'ok') {
			throw 'failed to setLnaGain';
		}
	}

	async setAntennaEnable(value: boolean): Promise<void> {
		const result = await this.device.controlTransferOut({
			requestType: "vendor",
			recipient: "device",
			request: HackRF.HACKRF_VENDOR_REQUEST_ANTENNA_ENABLE,
			value: value ? 1 : 0,
			index: 0,
		});
		if (result.status !== 'ok') {
			throw 'failed to setLnaGain';
		}
	}

	async reset(): Promise<void> {
		const result = await this.device.controlTransferOut({
			requestType: "vendor",
			recipient: "device",
			request: HackRF.HACKRF_VENDOR_REQUEST_RESET,
			value: 0,
			index: 0,
		});
		if (result.status !== 'ok') {
			throw 'failed to reset';
		}
	}

	async startRx(callback: RxCallback): Promise<void> {
		if (this.rxRunning) {
			await this.stopRx();
		}

		await this.setTransceiverMode(HackRF.HACKRF_TRANSCEIVER_MODE_RECEIVE);
		const transfer = async (): Promise<void> => {
			await Promise.resolve();
			while (this.rxRunning) {
				try {
					const result = await this.device.transferIn(1, HackRF.TRANSFER_BUFFER_SIZE);
					if (result.status !== 'ok') {
						console.error('startRx: transfer status not ok:', result.status);
						break;
					}
					callback(new Uint8Array(result.data!.buffer, 0, result.data!.byteLength));
				} catch (e: unknown) {
					if (this.rxRunning) {
						const msg = e instanceof Error ? e.message : String(e);
						console.error('startRx: transfer error:', msg);
					}
				break;
				}
			}
			// transfer loop ended
		};
		this.rxRunning = Array.from({ length: 8 }, transfer);
	}

	async startRxSweep(callback: RxCallback): Promise<void> {
		await this.usbApiRequired(0x0104);

		if (this.rxRunning) {
			await this.stopRx();
		}

		await this.setTransceiverMode(HackRF.TRANSCEIVER_MODE_RX_SWEEP);
		const transfer = async (): Promise<void> => {
			await Promise.resolve();
			while (this.rxRunning) {
				try {
					const result = await this.device.transferIn(1, HackRF.TRANSFER_BUFFER_SIZE);
					if (result.status !== 'ok') {
						console.error('startRxSweep: transfer status not ok:', result.status);
						break;
					}
					callback(new Uint8Array(result.data!.buffer, 0, result.data!.byteLength));
				} catch (e: unknown) {
					if (this.rxRunning) {
						const msg = e instanceof Error ? e.message : String(e);
						console.error('startRxSweep: transfer error:', msg);
					}
					break;
				}
			}
			// transfer loop ended
		};
		this.rxRunning = Array.from({ length: 8 }, transfer);
	}

	async boardRevRead(): Promise<number> {
		await this.usbApiRequired(0x0106);

		const result = await this.device.controlTransferIn({
			requestType: "vendor",
			recipient: "device",
			request: HackRF.HACKRF_VENDOR_REQUEST_BOARD_REV_READ,
			value: 0,
			index: 0,
		}, 1);
		if (result.status !== 'ok') {
			throw 'failed to boardRevRead';
		}
		return result.data!.getUint8(0);
	}

	async readSupportedPlatform(): Promise<number> {
		await this.usbApiRequired(0x0106);

		const result = await this.device.controlTransferIn({
			requestType: "vendor",
			recipient: "device",
			request: HackRF.HACKRF_VENDOR_REQUEST_SUPPORTED_PLATFORM_READ,
			value: 0,
			index: 0,
		}, 4);
		if (result.status !== 'ok') {
			throw 'failed to readSupportedPlatform';
		}
		// Firmware returns big-endian: (data[0]<<24 | data[1]<<16 | data[2]<<8 | data[3])
		return result.data!.getUint32(0, false);
	}

	async getOperacakeBoards(): Promise<number[]> {
		const result = await this.device.controlTransferIn({
			requestType: "vendor",
			recipient: "device",
			request: HackRF.HACKRF_VENDOR_REQUEST_OPERACAKE_GET_BOARDS,
			value: 0,
			index: 0,
		}, 8);
		if (result.status !== 'ok') {
			throw 'failed to getOperacakeBoards';
		}
		const boards: number[] = [];
		for (let i = 0; i < 8; i++) {
			const addr = result.data!.getUint8(i);
			if (addr === 0xFF) break; // HACKRF_OPERACAKE_ADDRESS_INVALID
			boards.push(addr);
		}
		return boards;
	}

	async setFreq(freqHz: number): Promise<void> {
		const data = new DataView(new ArrayBuffer(8));
		const freqMhz = Math.floor(freqHz / 1e6);
		const freqHz0 = freqHz - (freqMhz * 1e6);
		data.setUint32(0, freqMhz, true);
		data.setUint32(4, freqHz0, true);
		const result = await this.device.controlTransferOut({
			requestType: "vendor",
			recipient: "device",
			request: HackRF.HACKRF_VENDOR_REQUEST_SET_FREQ,
			value: 0,
			index: 0,
		}, data.buffer);
		if (result.status !== 'ok') {
			throw 'failed to setFreq';
		}
	}

	async initSweep(frequencyList: number[], numBytes: number, stepWidth: number, offset: number, style: number): Promise<void> {
		const numRanges = frequencyList.length / 2;
		if (numRanges < 1 || numRanges > HackRF.MAX_SWEEP_RANGES) {
			throw "invalid numRanges";
		}
		if (numBytes % HackRF.BYTES_PER_BLOCK || HackRF.BYTES_PER_BLOCK > numBytes) {
			throw "invalid numBytes";
		}
		if (stepWidth < 1) {
			throw "invalid stepWidth";
		}

		const data = new DataView(new ArrayBuffer(9 + numRanges * 2 * 2));
		data.setUint8(0, (stepWidth >> 0) & 0xff);
		data.setUint8(1, (stepWidth >> 8) & 0xff);
		data.setUint8(2, (stepWidth >> 16) & 0xff);
		data.setUint8(3, (stepWidth >> 24) & 0xff);
		data.setUint8(4, (offset >> 0) & 0xff);
		data.setUint8(5, (offset >> 8) & 0xff);
		data.setUint8(6, (offset >> 16) & 0xff);
		data.setUint8(7, (offset >> 24) & 0xff);
		data.setUint8(8, (style) & 0xff);
		for (let i = 0; i < numRanges * 2; i++) {
			data.setUint8(9 + i * 2, frequencyList[i] & 0xff);
			data.setUint8(10 + i * 2, (frequencyList[i] >> 8) & 0xff);
		}
		const result = await this.device.controlTransferOut({
			requestType: "vendor",
			recipient: "device",
			request: HackRF.HACKRF_VENDOR_REQUEST_INIT_SWEEP,
			value: numBytes & 0xffff,
			index: (numBytes >> 16) & 0xffff,
		}, data.buffer);
		if (result.status !== 'ok') {
			throw 'failed to initSweep';
		}
	}

	async stopRx(): Promise<void> {
		if (this.rxRunning) {
			const promises = this.rxRunning;
			this.rxRunning = null;
			try {
				await Promise.allSettled(promises);
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				console.warn('stopRx: error during transfer shutdown:', msg);
			}
		}
		try {
			await this.setTransceiverMode(HackRF.HACKRF_TRANSCEIVER_MODE_OFF);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.warn('stopRx: error setting mode off:', msg);
		}
	}

	async stopTx(): Promise<void> {
		await this.setTransceiverMode(HackRF.HACKRF_TRANSCEIVER_MODE_OFF);
	}

	async close(): Promise<void> {
		await this.stopRx();
		await this.stopTx();
	}

	async exit(): Promise<void> {
		await this.device.close();
	}
}

export { HackRF };
