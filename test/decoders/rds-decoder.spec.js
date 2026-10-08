import { describe, expect, it } from 'vitest';
import { RDSDecoder } from '../../src/client/worker/decoders/rds';

const offsets = [0xfc, 0x198, 0x168, 0x1b4];

function blockBits(data, index) {
	let remainder = data << 10;
	for (let bit = 25; bit >= 10; bit--) {
		if ((remainder >>> bit) & 1) remainder ^= 0x5b9 << (bit - 10);
	}
	const block = (data << 10) | (remainder ^ offsets[index]);
	return Array.from({ length: 26 }, (_, bit) => (block >>> (25 - bit)) & 1);
}

function groupBits(words) {
	return words.flatMap(blockBits);
}

function stationBits() {
	const groups = [];
	const ps = 'channelX';
	for (let segment = 0; segment < 4; segment++) {
		groups.push(groupBits([0x9240, segment, 0, (ps.charCodeAt(segment * 2) << 8) | ps.charCodeAt(segment * 2 + 1)]));
	}
	const rt = 'Madness - Our House\r'.padEnd(20, ' ');
	for (let segment = 0; segment < 5; segment++) {
		const base = segment * 4;
		groups.push(
			groupBits([
				0x9240,
				0x2000 | segment,
				(rt.charCodeAt(base) << 8) | rt.charCodeAt(base + 1),
				(rt.charCodeAt(base + 2) << 8) | rt.charCodeAt(base + 3),
			]),
		);
	}
	return groups.flat();
}

function makeMpx(bits, sampleRate, phase = 0, noise = 0) {
	let previous = 1;
	const symbols = bits.flatMap((bit) => {
		if (bit) previous = -previous;
		return [previous, -previous];
	});
	const samples = new Float32Array(Math.ceil((symbols.length * sampleRate) / 2375));
	let random = 12345;
	let shaped = 0;
	const alpha = 1 - Math.exp((-2 * Math.PI * 2400) / sampleRate);
	for (let index = 0; index < samples.length; index++) {
		const t = index / sampleRate;
		const symbol = symbols[Math.min(symbols.length - 1, Math.floor(t * 2375))];
		shaped += alpha * (symbol - shaped);
		random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
		samples[index] =
			0.1 * Math.cos(2 * Math.PI * 19000 * t) +
			0.03 * shaped * Math.cos(2 * Math.PI * 57000 * t + phase) +
			0.3 * Math.sin(2 * Math.PI * 1000 * t) +
			noise * ((random / 0xffffffff) * 2 - 1);
	}
	return samples;
}

describe('RDS decoding', () => {
	it('updates the current programme-type label when region changes without clearing decoded text', () => {
		const messages = [];
		const decoder = new RDSDecoder(250000, (message) => messages.push(message));
		decoder.setRegion('na');
		expect(messages).toHaveLength(0);
		decoder.setRegion('eu');
		for (const bit of stationBits()) decoder.processBit(bit);
		decoder.blocks = [0x9240, 10 << 5, 0, 0];
		decoder.blockValid = [true, true, false, false];
		decoder.decodeGroup();
		expect(messages.at(-1)).toEqual({ pty: 10, ptyLabel: 'Pop Music' });
		const text = decoder.buildRT();
		decoder.setRegion('na');
		expect(messages.at(-1)).toEqual({ pty: 10, ptyLabel: 'Country' });
		expect(decoder.buildRT()).toBe(text);
		const count = messages.length;
		decoder.setRegion('na');
		expect(messages).toHaveLength(count);
		decoder.setRegion('eu');
		expect(messages.at(-1)).toEqual({ pty: 10, ptyLabel: 'Pop Music' });
	});
	it.each([0, Math.PI / 2])('decodes biphase RadioText and PS from MPX at carrier phase %s', (phase) => {
		const messages = [];
		const decoder = new RDSDecoder(250000, (message) => messages.push(message));
		const bits = Array.from({ length: 5 }, stationBits).flat();
		const samples = makeMpx(bits, 250000, phase, 0.01);
		for (let start = 0; start < samples.length; start += 813) decoder.process(samples.subarray(start, start + 813));
		expect(messages).toContainEqual({ ps: 'channelX' });
		expect(messages).toContainEqual({ rt: 'Madness - Our House' });
	});
	it('reacquires after reset at another sample rate with irregular chunk boundaries', () => {
		const messages = [];
		const decoder = new RDSDecoder(171000, (message) => messages.push(message));
		const samples = makeMpx(Array.from({ length: 5 }, stationBits).flat(), 171000, Math.PI * 0.8, 0.02);
		const feed = () => {
			for (let start = 0; start < samples.length; start += 719) decoder.process(samples.subarray(start, start + 719));
		};
		feed();
		expect(messages).toContainEqual({ rt: 'Madness - Our House' });
		messages.length = 0;
		decoder.reset();
		feed();
		expect(messages).toContainEqual({ ps: 'channelX' });
		expect(messages).toContainEqual({ rt: 'Madness - Our House' });
	});
	it('assembles independently valid C/D pairs without displaying gaps or a terminator', () => {
		const messages = [];
		const decoder = new RDSDecoder(250000, (message) => messages.push(message));
		const send = (segment, text, valid, flag = 0) => {
			decoder.blocks = [
				0x9240,
				0x2000 | (flag << 4) | segment,
				(text.charCodeAt(0) << 8) | text.charCodeAt(1),
				(text.charCodeAt(2) << 8) | text.charCodeAt(3),
			];
			decoder.blockValid = [true, true, ...valid];
			decoder.decodeGroup();
		};
		send(1, 'ess ', [true, true]);
		expect(messages.some((message) => message.rt)).toBe(false);
		send(0, 'Madn', [true, false]);
		expect(messages.some((message) => message.rt)).toBe(false);
		send(0, 'Madn', [false, true]);
		expect(messages).toContainEqual({ rt: 'Madness' });
		send(2, '- Ou', [true, true]);
		send(3, 'r Ho', [true, true]);
		send(4, 'use\r', [true, true]);
		send(5, 'JUNK', [true, true]);
		expect(messages.at(-1)).toEqual({ rt: 'Madness - Our House' });
		send(0, 'Next', [true, true], 1);
		expect(messages.at(-1)).toEqual({ rt: 'Next' });
	});
	it('reacquires block alignment promptly after a bit slip', () => {
		const messages = [];
		const decoder = new RDSDecoder(250000, (message) => messages.push(message));
		for (const bit of stationBits()) decoder.processBit(bit);
		messages.length = 0;
		decoder.reset();
		const first = stationBits();
		for (const bit of first.slice(0, 110)) decoder.processBit(bit);
		decoder.processBit(1);
		for (const bit of [...first.slice(110), ...stationBits(), ...stationBits()]) decoder.processBit(bit);
		expect(messages).toContainEqual({ ps: 'channelX' });
		expect(messages).toContainEqual({ rt: 'Madness - Our House' });
	});
});
