import { rs41Crc } from './rs41';
import type { Radiosonde, SondeField } from './types';

/** Per-sonde calibration/configuration assembled only from CRC-valid identities. */
export class Rs41Calibration {
	readonly bytes = new Uint8Array(816);
	private received = new Set<number>();
	total = 51;
	update(identity: Uint8Array): void {
		const index = identity[23];
		this.total = Math.min(51, identity[22] + 1);
		if (index > 50 || index >= this.total) return;
		this.bytes.set(identity.subarray(24, 40), index * 16);
		this.received.add(index);
	}
	has(offset: number, length = 4): boolean {
		for (let index = Math.floor(offset / 16); index <= Math.floor((offset + length - 1) / 16); index++)
			if (!this.received.has(index)) return false;
		return true;
	}
	float(offset: number): number {
		return new DataView(this.bytes.buffer).getFloat32(offset, true);
	}
	floats(offset: number, count: number): number[] {
		return Array.from({ length: count }, (_, index) => this.float(offset + index * 4));
	}
	private integer(offset: number, width = 2, signed = false): number {
		const view = new DataView(this.bytes.buffer);
		if (width === 1) return signed ? view.getInt8(offset) : view.getUint8(offset);
		if (width === 4) return view.getUint32(offset, true);
		return signed ? view.getInt16(offset, true) : view.getUint16(offset, true);
	}
	private string(offset: number, length: number): string | undefined {
		if (!this.has(offset, length)) return undefined;
		const bytes = this.bytes.subarray(offset, offset + length);
		const end = bytes.indexOf(0);
		const text = String.fromCharCode(...bytes.subarray(0, end < 0 ? length : end));
		return /^[\x20-\x7e]+$/.test(text) ? text.trim() : undefined;
	}
	telemetry(now: number): Partial<Radiosonde> {
		const result: Partial<Radiosonde> = {
			calibrationCount: this.received.size,
			calibrationTotal: this.total,
			calibrationComplete: this.has(0, 800) && this.integer(0) === rs41Crc(this.bytes.subarray(2, 800)),
			calibrationFragments: [...this.received]
				.sort((a, b) => a - b)
				.map((index) => ({
					index,
					data: Array.from(this.bytes.subarray(index * 16, index * 16 + 16), (byte) => byte.toString(16).padStart(2, '0')).join(''),
				})),
			configuration: this.fields(),
		};
		for (const [key, offset, length] of [
			['subtype', 0x218, 10],
			['mainboard', 0x222, 10],
			['mainboardSerial', 0x22c, 9],
			['pressureSensorSerial', 0x243, 8],
		] as const) {
			const text = this.string(offset, length);
			if (text) result[key] = text;
		}
		if (this.has(2, 2)) result.txFrequency = 400 + this.integer(2) / 6400;
		if (this.has(0x15)) result.firmware = this.integer(0x15, 4);
		if (this.has(0x2b, 1)) result.burstKill = this.integer(0x2b, 1) !== 0;
		if (this.has(0x27, 2)) result.flightTimer = this.integer(0x27, 2, true);
		if (this.has(0x316, 2)) result.burstTimer = this.integer(0x316, 2, true);
		if (this.has(0x320, 2)) {
			result.killCountdown = this.integer(0x320, 2, true);
			result.killCountdownTime = now;
		}
		return result;
	}
	private fields(): SondeField[] {
		// Offsets/units from the published RS41 calibration structure.
		const descriptors: Array<[string, number, number, string?, boolean?, number?]> = [
			['Startup TX power level', 4, 1],
			['Option flags', 7, 2],
			['Flight-mode minimum height', 0x19, 2, 'm'],
			['Low battery voltage threshold', 0x1b, 1, 'V', false, 0.1],
			['NFC detector threshold', 0x1c, 1, 'V', false, 0.025],
			['Reference temperature target', 0x21, 1, '°C', true],
			['Low battery capacity threshold', 0x22, 1, 'Wmin'],
			['Fresh battery capacity', 0x2e, 2, 'mWh'],
			['XDATA enabled', 0x32, 1],
			['u-blox hardware version high', 0x33, 2],
			['u-blox hardware version low', 0x35, 2],
			['u-blox software version', 0x37, 2],
			['u-blox software build', 0x39, 2],
			['u-blox configuration errors', 0x3b, 1],
			['Radio version code', 0x3c, 1],
			['Watchdog setting', 0x1ec, 1],
			['Parameter setup complete', 0x1ed, 1],
			['Test mode enabled', 0x1ee, 1],
			['TX enabled', 0x1ef, 1],
			['XDATA UART baud code', 0x253, 1],
			['Launch altitude (spherical Earth)', 0x322, 2, 'm', true],
			['Flight start height above launch', 0x324, 2, 'm'],
			['Last TX power level', 0x326, 1],
			['Software reset count', 0x327, 1],
			['CPU temperature', 0x328, 1, '°C', true],
			['Radio temperature', 0x329, 1, '°C', true],
			['Remaining battery capacity', 0x32a, 2, 'mWh'],
			['Discarded UBX packets', 0x32c, 1],
			['UBX stalls', 0x32d, 1],
		];
		const fields = descriptors
			.filter(([, offset, width]) => this.has(offset, width))
			.map(([label, offset, width, unit, signed, scale]) => ({
				label,
				value: this.integer(offset, width, signed) * (scale ?? 1),
				...(unit ? { unit } : {}),
			}));
		for (const [label, offset, unit] of [
			['Launch-site pressure 1', 0x210, 'hPa'],
			['Launch-site pressure 2', 0x214, 'hPa'],
			['CPU sensor voltage at 25°C', 0x255, 'V'],
		] as const)
			if (this.has(offset) && Number.isFinite(this.float(offset))) fields.push({ label, value: this.float(offset), unit });
		return fields;
	}
}
