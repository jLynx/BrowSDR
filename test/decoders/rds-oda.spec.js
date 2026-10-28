import { describe, it, expect } from 'vitest';
import { RDSDecoder } from '@/worker/decoders/rds';

function receiver() {
	const messages = [];
	const decoder = new RDSDecoder(250000, (x) => messages.push(x));
	const send = (b, c, d, valid = [true, true]) => {
		decoder.blocks = [0x9240, b, c, d];
		decoder.blockValid = [true, true, ...valid];
		decoder.decodeGroup();
	};
	send(0x3000 | (12 << 1), 1, 0x6552);
	const text = (value, pty = 0) => {
		const padded = (value + '\r').padEnd(Math.ceil((value.length + 1) / 4) * 4, ' ');
		for (let seg = 0; seg < padded.length / 4; seg++) {
			const offset = seg * 4;
			send(
				0xc000 | seg | ((typeof pty === 'function' ? pty(seg) : pty) << 5),
				(padded.charCodeAt(offset) << 8) | padded.charCodeAt(offset + 1),
				(padded.charCodeAt(offset + 2) << 8) | padded.charCodeAt(offset + 3),
			);
		}
	};
	return { messages, decoder, send, text };
}

describe('eRT segment assembly', () => {
	it('uses all 32 segment addresses and ignores PTY changes', () => {
		const rx = receiver();
		const text = 'FIRST-HALF-'.padEnd(64, 'A') + 'SECOND-HALF-END!!';
		rx.text(text, (seg) => (seg >= 16 ? 1 : 0));
		expect(rx.messages).toContainEqual(expect.objectContaining({ eRT: text }));
	});
	it('assembles a replacement text with the same PTY and deduplicates repeats', () => {
		const rx = receiver();
		rx.text('FIRST MESSAGE');
		rx.text('SECOND PAGE');
		rx.text('SECOND PAGE');
		expect(rx.messages.filter((x) => x.eRT).map((x) => x.eRT)).toEqual(['FIRST MESSAGE', 'SECOND PAGE']);
	});
	it('reassembles when a later segment changes but the prefix is identical', () => {
		const rx = receiver();
		rx.text('SAME OLD MESSAGE');
		rx.text('SAME NEW MESSAGE');
		rx.text('SAME NEW MESSAGE');
		expect(rx.messages.filter((x) => x.eRT).map((x) => x.eRT)).toEqual(['SAME OLD MESSAGE', 'SAME NEW MESSAGE']);
	});
	it('repairs an unavailable block without discarding the other received bytes', () => {
		const rx = receiver();
		rx.send(0xc000, 0x4142, 0x4344, [false, true]);
		rx.send(0xc000, 0x4142, 0x4344, [true, false]);
		rx.send(0xc001, 0x0d20, 0x2020);
		expect(rx.messages).toContainEqual(expect.objectContaining({ eRT: 'ABCD' }));
	});
});
