import { bchEncode } from '@/worker/decoders/flex/bch';
import { FlexFrontend } from '@/worker/decoders/flex/frontend';
// FLEX S1 wire words and S2 C/inv.C patterns. Data words are sent LSB-first,
// interleaved in groups of 8.
export const modes = {
	A1: { a: 0x78f35939, baud: 1600, levels: 2, phases: [0] },
	A2: { a: 0x84e75939, baud: 3200, levels: 2, phases: [0, 2] },
	A3: { a: 0x4f975939, baud: 1600, levels: 4, phases: [0, 2] },
	A4: { a: 0x215f5939, baud: 3200, levels: 4, phases: [0, 1, 2, 3] },
};
const bitsMSB = (word, n = 32) => Array.from({ length: n }, (_, i) => (word >>> (n - 1 - i)) & 1);
const bitsLSB = (word) => Array.from({ length: 32 }, (_, i) => (word >>> i) & 1);
const symbol = (a, b) => (a ? (b ? 2 : 3) : b ? 1 : 0);
export function words(seed = 123) {
	let s = seed;
	return Array.from({ length: 4 }, () =>
		Uint32Array.from({ length: 88 }, () => {
			s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
			return bchEncode(s & 0x1fffff);
		}),
	);
}
export function messageWords(text = 'HELLO WORLD', idle = 0) {
	const payload = Array(88).fill(idle);
	const chars = [...text].map((c) => c.charCodeAt(0));
	const sig = ~chars.reduce((s, c) => s + c, 0) & 127;
	const slots = [sig, ...chars];
	while (slots.length % 3) slots.push(3);
	const body = [];
	for (let i = 0; i < slots.length; i += 3) body.push(slots[i] | (slots[i + 1] << 7) | (slots[i + 2] << 14));
	let hdr = 3 << 11;
	const groups = (x) => (x & 255) + ((x >>> 8) & 255) + ((x >>> 16) & 31);
	const k = ~[hdr, ...body].reduce((s, x) => s + groups(x), 0) & 1023;
	hdr |= k;
	payload[0] = (2 << 10) | 7;
	payload[1] = 1234567 + 32768;
	payload[2] = (5 << 4) | (3 << 7) | ((body.length + 1) << 14);
	payload[3] = hdr;
	body.forEach((x, i) => (payload[4 + i] = x));
	return Array.from({ length: 4 }, () => Uint32Array.from(payload, bchEncode));
}
export function transmission(name, phaseWords = words(), { lead = 64 } = {}) {
	const m = modes[name],
		out = [];
	const push = (sym, baud, section) => out.push({ sym: section === 's1' || section === 'tail' ? sym : 3 - sym, baud, section });
	for (let i = 0; i < lead; i++) push(i & 1 ? 0 : 3, 1600, 's1');
	const s1 = [...bitsMSB(0xaaaaaaaa), ...bitsMSB(m.a), ...bitsMSB(0x5555, 16), ...bitsMSB(~m.a)];
	s1.forEach((b) => push(b ? 0 : 3, 1600, 's1'));
	let info = (3 << 4) | (42 << 8);
	let sum = 0;
	for (let i = 4; i <= 20; i += 4) sum += (info >>> i) & 15;
	info |= (15 - sum) & 15;
	bitsLSB(bchEncode(info)).forEach((b) => push(b ? 3 : 0, 1600, 'fiw'));
	const bitCount = m.baud * 0.025 * (m.levels === 4 ? 2 : 1);
	const bsLength = bitCount / 2 - 16;
	const half = [...Array.from({ length: bsLength }, (_, i) => i & 1), ...bitsMSB(0xed84, 16)];
	const s2 = [...half, ...half.map((b) => 1 - b)];
	for (let i = 0; i < s2.length; i += m.levels === 4 ? 2 : 1) push(m.levels === 4 ? symbol(s2[i], s2[i + 1]) : s2[i] ? 3 : 0, m.baud, 's2');
	for (let block = 0; block < 11; block++)
		for (let bit = 0; bit < 32; bit++)
			for (let w = 0; w < 8; w++) {
				const idx = block * 8 + w;
				if (m.baud === 1600)
					push(symbol((phaseWords[0][idx] >>> bit) & 1, m.levels === 4 ? (phaseWords[2][idx] >>> bit) & 1 : 0), m.baud, 'data');
				else {
					push(symbol((phaseWords[0][idx] >>> bit) & 1, m.levels === 4 ? (phaseWords[1][idx] >>> bit) & 1 : 0), m.baud, 'data');
					push(symbol((phaseWords[2][idx] >>> bit) & 1, m.levels === 4 ? (phaseWords[3][idx] >>> bit) & 1 : 0), m.baud, 'data');
				}
			}
	for (let i = 0; i < 24; i++) push(i & 1 ? 0 : 3, 1600, 'tail');
	return out;
}
export function render(tx, { amp = 0.5, dc = 0, polarity = 1, ppm = 0, smoothing = 0.2 } = {}) {
	const data = [],
		level = [-1, -1 / 3, 1 / 3, 1];
	let time = 0,
		y = 0;
	for (const item of tx) {
		time += 48000 / item.baud / (1 + ppm / 1e6);
		while (data.length < time) {
			const x = polarity * level[item.sym] * amp + dc;
			y += smoothing * (x - y);
			data.push(y);
		}
	}
	return Float32Array.from(data);
}
export function receive(audio, { chunk = audio.length } = {}) {
	const frames = [],
		locks = [];
	const fe = new FlexFrontend(48000, {
		onLock: (l) => locks.push({ locked: l, sample: pos, state: fe.state }),
		onFrame: (p, active, fiw) =>
			frames.push({
				words: p.map((x) => Array.from(x.words)),
				alt: p.map((x) => Array.from(x.altWords)),
				received: p.map((x) => Array.from(x.receivedBits)),
				altReceived: p.map((x) => Array.from(x.altReceivedBits)),
				active,
				fiw,
			}),
	});
	let pos = 0;
	for (; pos < audio.length; pos += chunk) fe.process(audio.subarray(pos, pos + chunk));
	return { frames, locks, state: fe.state, locked: fe.locked, fe };
}
export function errors(actual, expected, phases) {
	let bits = 0,
		wordCount = 0;
	const mismatch = [];
	for (const p of phases)
		for (let w = 0; w < 88; w++) {
			let x = (actual[p][w] ^ expected[p][w]) >>> 0;
			if (x) {
				wordCount++;
				mismatch.push([p, w, x.toString(16)]);
			}
			while (x) {
				bits++;
				x &= x - 1;
			}
		}
	return { bits, wordCount, mismatch: mismatch.slice(0, 12) };
}
