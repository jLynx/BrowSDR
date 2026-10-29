import { describe, expect, it } from 'vitest';
import { LoraReceiver } from '@/worker/decoders/rtk/lora';
import { mockRtkIq } from '../fixtures/rtk/mock-iq';
import { mockRadioPayload } from '../fixtures/rtk/mock-packet';

const profile = { bandwidth: 500000, oversample: 2, sync: [40, 36], ldro: true };
function run(iq, chunks) {
	const packets = [];
	const receiver = new LoraReceiver(profile, 20, (packet) => packets.push(packet));
	let chunk = 0;
	for (let at = 0; at < iq.length;) {
		const end = Math.min(iq.length, at + chunks[chunk++ % chunks.length]);
		receiver.process(iq.subarray(at, end));
		at = end;
	}
	return { packets, counters: receiver.counters };
}

describe('browser LoRa streaming PHY', () => {
	it('recovers the complete mock payload across irregular USB boundaries', () => {
		const data = mockRtkIq();
		const iq = Float32Array.from(new Int8Array(data.buffer, data.byteOffset, data.length), (value) => value / 128);
		for (const chunks of [[16384], [102, 8190, 230, 65536]]) {
			const result = run(iq, chunks);
			expect(result.counters.headers).toBe(1);
			expect(result.packets.filter((packet) => packet.verified)).toHaveLength(1);
			expect(result.packets[0].data).toEqual(mockRadioPayload());
		}
	});

	it('rejects a corrupted payload after acquiring a valid preamble and header', () => {
		const raw = mockRtkIq();
		const iq = Float32Array.from(new Int8Array(raw.buffer, raw.byteOffset, raw.length), (value) => value / 128);
		iq.fill(0, 150000, 155000);
		const result = run(iq, [16384]);
		expect(result.counters.headers).toBe(1);
		expect(result.counters.crcErrors).toBe(1);
		expect(result.packets.filter((packet) => packet.verified)).toEqual([]);
	});
});
