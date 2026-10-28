import { it, expect } from 'vitest';
import { modes, words, messageWords, transmission, render, receive, errors } from './fixtures.js';
import { FlexDecoder } from '@/worker/decoders/flex/decoder';
import { decodeFrame } from '@/worker/decoders/flex/frame';

for (const name of Object.keys(modes))
	for (const polarity of [1, -1])
		it(`control: ${name}, polarity ${polarity}, complete clean frame`, () => {
			const expected = words(),
				r = receive(render(transmission(name, expected), { polarity }), { chunk: 1024 });
			expect(r.frames).toHaveLength(1);
			expect(r.frames[0].active).toEqual(modes[name].phases);
			expect(errors(r.frames[0].words, expected, modes[name].phases).bits).toBe(0);
			for (const phase of modes[name].phases) {
				expect(r.frames[0].received[phase]).toEqual(Array(88).fill(32));
				expect(r.frames[0].altReceived[phase]).toEqual(Array(88).fill(32));
			}
		});
for (const name of ['A3', 'A4'])
	it(`${name} discards old hunt samples before calibrating the next frame`, () => {
		const expected = words();
		const frame = render(transmission(name, expected).filter((x) => x.section !== 'tail'));
		const interference = Float32Array.from({ length: 48000 }, (_, i) => 0.95 * Math.sin((2 * Math.PI * 8000 * i) / 48000));
		const r = receive(Float32Array.from([...frame, ...interference, ...render(transmission(name, expected))]), { chunk: 1024 });
		expect(r.frames).toHaveLength(2);
		expect(errors(r.frames[1].words, expected, modes[name].phases).bits).toBe(0);
	});
for (const name of Object.keys(modes))
	it(`${name} does not validate truncated message words as zero fill`, () => {
		const tx = transmission(name, messageWords('HELLO WORLD AGAIN'));
		const dataStart = tx.findIndex((x) => x.section === 'data');
		const count = modes[name].baud === 1600 ? 320 : 640;
		const prefix = render(tx.slice(0, dataStart + count));
		const audio = Float32Array.from([...prefix, ...new Float32Array(48000 / 4)]);
		const actual = [],
			decoder = new FlexDecoder(48000, (x) => actual.push(x));
		for (let i = 0; i < audio.length; i += 127) decoder.process(audio.subarray(i, i + 127));
		expect(actual).toHaveLength(modes[name].phases.length);
		for (const message of actual) {
			expect(message.text).toBe('HELLO WORLD??????');
			expect(message.kOk).toBeNull();
			expect(message.sigOk).toBeNull();
			expect(message.charStatus).toContain(2);
		}
	});
it('does not emit a message when the BIW itself is incomplete', () => {
	const tx = transmission('A1', messageWords());
	const dataStart = tx.findIndex((x) => x.section === 'data');
	const prefix = render(tx.slice(0, dataStart + 32));
	const actual = [],
		decoder = new FlexDecoder(48000, (x) => actual.push(x));
	decoder.process(Float32Array.from([...prefix, ...new Float32Array(48000 / 4)]));
	expect(actual).toHaveLength(0);
});
it('does not replace a corrupt primary word with an incomplete zero-filled alternate', () => {
	const phases = messageWords().map((w) => ({
		words: w,
		status: new Int8Array(88),
		lowConfBitA: new Uint32Array(88),
		lowConfBitB: new Uint32Array(88),
		altWords: w.slice(),
		receivedBits: new Uint8Array(88).fill(32),
		altReceivedBits: new Uint8Array(88).fill(32),
		idleCount: 0,
	}));
	phases[0].words[4] = 0x0f0f0f0f;
	phases[0].altWords[4] = 0;
	phases[0].altReceivedBits[4] = 31;
	const fiw = { cycle: 3, frame: 42, roaming: 0, repeat: 0, traffic: 0, numTransmissions: 1, tdCollapse: -1 };
	const messages = decodeFrame(phases, [0], fiw, 0);
	expect(messages).toHaveLength(1);
	expect(messages[0].text).toBe('??LLO WORLD');
	expect(messages[0].kOk).toBeNull();
	expect(messages[0].sigOk).toBeNull();
	expect(messages[0].charStatus.slice(0, 2)).toEqual([2, 2]);
});
it('control: sample chunk boundaries preserve the result in all modes', () => {
	for (const name of Object.keys(modes)) {
		const expected = words(),
			audio = render(transmission(name, expected), { dc: 0.1, ppm: 100 });
		const whole = receive(audio).frames;
		for (const chunk of [1, 127, 511, 1024, 4096]) expect(receive(audio, { chunk }).frames).toEqual(whole);
	}
});
for (const name of Object.keys(modes))
	for (const idle of [0, 0x1fffff])
		it(`regression: ${name} must emit a complete message before ${idle === 0 ? 'zero' : 'one'} idle fill`, () => {
			const expected = messageWords('HELLO WORLD', idle);
			const ph = expected.map((w) => ({
				words: w,
				status: new Int8Array(88),
				lowConfBitA: new Uint32Array(88),
				lowConfBitB: new Uint32Array(88),
				altWords: w.slice(),
				idleCount: 0,
			}));
			const fiw = { cycle: 3, frame: 42, roaming: 0, repeat: 0, traffic: 0, numTransmissions: 1, tdCollapse: -1 };
			const decoded = decodeFrame(ph, modes[name].phases, fiw, 0);
			expect(decoded.map((x) => ({ text: x.text, k: x.kOk, sig: x.sigOk }))).toEqual(
				modes[name].phases.map(() => ({ text: 'HELLO WORLD', k: true, sig: true })),
			);
			const audio = render(transmission(name, expected));
			const actual = [],
				decoder = new FlexDecoder(48000, (x) => actual.push(x));
			for (let i = 0; i < audio.length; i += 1024) decoder.process(audio.subarray(i, i + 1024));
			expect(actual.map((x) => x.text)).toEqual(modes[name].phases.map(() => 'HELLO WORLD'));
		});
for (const name of ['A3', 'A4'])
	it(`regression: ${name} should calibrate the next preamble independently`, () => {
		const expected = words();
		const first = render(transmission(name, expected).filter((x) => x.section !== 'tail'));
		const second = render(transmission(name, expected), { amp: 0.2 });
		const fresh = receive(second, { chunk: 1024 });
		expect(errors(fresh.frames[0].words, expected, modes[name].phases).bits).toBe(0);
		const carried = receive(Float32Array.from([...first, ...second]), { chunk: 1024 });
		expect(carried.frames).toHaveLength(2);
		expect(errors(carried.frames[0].words, expected, modes[name].phases).bits).toBe(0);
		expect(errors(carried.frames[1].words, expected, modes[name].phases).bits).toBe(0);
	});
