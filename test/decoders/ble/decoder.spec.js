import { describe, expect, it } from 'vitest';
import { BleDemodulator } from '@/worker/decoders/ble/demodulator';
import { bleCrc, parseAdvertisement } from '@/worker/decoders/ble/packets';
import { mergeAdvertisements } from '@/app/decoders/ble/devices';
import { advertisement, crc, radioSignal } from './fixtures';

describe('BLE packets and radio demodulation', () => {
	it('matches independently calculated CRC, rejects corrupt packets and parses advertised fields', () => {
		const bytes = advertisement();
		expect(bleCrc(bytes.subarray(0, -3))).toBe(crc(bytes.subarray(0, -3)));
		expect(parseAdvertisement(bytes, 37, -20)).toMatchObject({
			address: 'C6:05:04:03:02:01',
			name: 'TEST',
			addressType: 'random',
			services: ['180F'],
			manufacturer: 0x4c,
		});
		bytes[8] ^= 1;
		expect(parseAdvertisement(bytes, 37, -20)).toBeNull();
	});
	it.each([37, 38, 39])('decodes Gaussian IQ on channel %s across arbitrary chunk boundaries and symbol phases', (channel) => {
		for (const phase of [0, 0.25, 0.5, 0.75])
			for (const invert of [false, true]) {
				const packets = [];
				const decoder = new BleDemodulator(channel, (packet) => packets.push(packet));
				const input = radioSignal(advertisement(), channel, 2000000, 40000, phase, invert, 0.03);
				for (let i = 0; i < input.length; i += 94) decoder.process(input.subarray(i, i + 94));
				expect(packets, `phase=${phase}, invert=${invert}`).toHaveLength(1);
				expect(packets[0].name).toBe('TEST');
			}
	});
	it('rejects wrong whitening, bad CRC, reserved/extended PDUs and resets partial packets', () => {
		const packets = [];
		const decoder = new BleDemodulator(38, (packet) => packets.push(packet));
		decoder.process(radioSignal(advertisement(), 37));
		for (const type of [3, 5, 7, 15]) decoder.process(radioSignal(advertisement(type), 38));
		const corrupt = advertisement();
		corrupt[corrupt.length - 1] ^= 1;
		decoder.process(radioSignal(corrupt, 38));
		const input = radioSignal(advertisement(), 38);
		decoder.process(input.subarray(0, 300));
		decoder.reset();
		decoder.process(input.subarray(300));
		expect(packets).toEqual([]);
		decoder.process(input);
		expect(packets).toHaveLength(1);
	});
	it('accepts empty and directed advertisements and safely stops at truncated AD data', () => {
		expect(parseAdvertisement(advertisement(0, []), 37, -10)).toMatchObject({ data: '' });
		expect(parseAdvertisement(advertisement(1, [1, 2, 3, 4, 5, 6]), 37, -10)?.pduType).toBe('ADV_DIRECT_IND');
		expect(parseAdvertisement(advertisement(0, [20, 9, 65]), 37, -10)?.name).toBeUndefined();
	});
	it('merges scan responses and channels, preserves complete names, expires and bounds device addresses', () => {
		const first = parseAdvertisement(advertisement(), 37, -20);
		const second = { ...first, channel: 39, name: undefined, completeName: undefined, services: [] };
		const devices = mergeAdvertisements(mergeAdvertisements([], [first], 1000), [second], 2000);
		expect(devices[0]).toMatchObject({ name: 'TEST', services: ['180F'], channels: [37, 39], packets: 2, firstSeen: 1000 });
		expect(mergeAdvertisements(devices, [], 302001)).toEqual([]);
		expect(
			mergeAdvertisements(
				[],
				Array.from({ length: 600 }, (_, i) => ({ ...first, address: String(i) })),
				2000,
			),
		).toHaveLength(500);
	});
});
