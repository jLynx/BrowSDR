import { describe, expect, it, vi } from 'vitest';
import vectors from './fixtures/p25-vectors.json';
const codec = vi.hoisted(() => ({ imbe: vi.fn(() => new Float32Array(160)) }));
vi.mock('../src/client/worker/mbelib-init', () => ({
	ensureMbelibInitialized: async () => {}, decodeAmbe: () => new Float32Array(160),
	decodeImbe: codec.imbe, resetMbe: vi.fn(), getMbeErrors: () => 0,
}));
import { DSDDecoder } from '../src/client/worker/dsd/dsd-decoder';
import { extractP25IMBE, parseP25NID, processP25LDU1, processP25LDU2, processP25HDU, processP25TDULC } from '../src/client/worker/dsd/dsd-p25';

const frame = name => Uint8Array.from(vectors.frames[name], Number);
describe('P25 Phase 1 independent conformance vectors', () => {
	it('validates the BCH NID across its inserted status symbol and corrects errors', () => {
		const received = frame('ldu1');
		expect(parseP25NID(received, 24)).toMatchObject({ valid: true, nac: 0x293, duid: 5, errors: 0 });
		for (const offset of [24, 27, 29, 31, 33, 38, 40, 43, 48, 51, 54]) received[offset] ^= 1;
		expect(parseP25NID(received, 24)).toMatchObject({ valid: true, nac: 0x293, duid: 5, errors: 11 });
		received[55] ^= 1;
		expect(parseP25NID(received, 24).valid).toBe(false);
	});
	it('extracts nine correctly positioned voice frames and real link-control metadata', () => {
		const status = {};
		const frames = processP25LDU1(frame('ldu1'), 57, status);
		const dibits = Uint8Array.from({ length: 72 }, (_, i) => parseInt(vectors.imbe[Math.floor(i / 2)], 16) >> (i % 2 ? 0 : 2) & 3);
		const expected = extractP25IMBE(dibits, 0);
		expect(frames).toHaveLength(9);
		for (let i = 0; i < frames.length; i++) {
			const wanted = expected.slice();
			if (i % 2) wanted[7 * 23] ^= 1; // MSB of the final channel dibit.
			expect(frames[i]).toEqual(wanted);
		}
		expect(status).toMatchObject({ tg: vectors.tg, src: vectors.src, emr: true, encrypted: false });
	});
	it('decodes HDU, LDU2 and terminator metadata without fabricated zero fields', () => {
		const status = {};
		processP25HDU(frame('hdu'), 57, status);
		expect(status).toMatchObject({ tg: vectors.tg, algid: 0x80, kid: 0, encrypted: false });
		processP25LDU2(frame('encryptedLdu2'), 57, status);
		expect(status).toMatchObject({ algid: 0x84, kid: 0x4321, encrypted: true });
		processP25TDULC(frame('tdulc'), 57, status);
		expect(status).toMatchObject({ tg: vectors.tg, src: vectors.src, emr: true });
	});
	it('corrects independently encoded LC and HDU symbol errors', () => {
		const received = frame('ldu1');
		// The first LC hex word starts at physical bit 410, between voice 2 and 3.
		received[205] ^= 2; // one Hamming-correctable bit.
		received[207] ^= 3; // a damaged hex word for the outer Reed-Solomon code.
		const status = {};
		processP25LDU1(received, 57, status);
		expect(status).toMatchObject({ tg: vectors.tg, src: vectors.src });
		const header = frame('hdu');
		header[58] ^= 2; header[60] ^= 1;
		processP25HDU(header, 57, status);
		expect(status).toMatchObject({ tg: vectors.tg, algid: 0x80, encrypted: false });
	});
	it.each([false, true])('decodes consecutive units with inverted=%s, including a ring-buffer wrap', async inverted => {
		codec.imbe.mockClear();
		const statuses = [], audio = [];
		const decoder = new DSDDecoder(samples => audio.push(samples), status => statuses.push(status));
		await Promise.resolve(); await Promise.resolve();
		decoder.dibitBufPos = 65500;
		for (const name of ['hdu', 'ldu1', 'ldu2', 'tdulc', 'tdu']) {
			for (const d of frame(name)) decoder.feedDibit(d ^ (inverted ? 2 : 0));
		}
		expect(codec.imbe).toHaveBeenCalledTimes(18);
		expect(statuses.at(-1)).toMatchObject({ mode: 'p25', nac: vectors.nac, duid: 'TDU', voiceFrameCount: 18, syncCount: 5 });
		expect(audio.reduce((total, chunk) => total + chunk.length, 0) + decoder.audioAccumLen).toBe(2880);
	});
	it('reports and mutes encrypted voice while continuing to parse P25 units', async () => {
		codec.imbe.mockClear();
		const statuses = [];
		const decoder = new DSDDecoder(() => {}, status => statuses.push(status));
		await Promise.resolve(); await Promise.resolve();
		for (const name of ['encryptedHdu', 'encryptedLdu1', 'encryptedLdu2']) for (const d of frame(name)) decoder.feedDibit(d);
		expect(codec.imbe).not.toHaveBeenCalled();
		expect(statuses.at(-1)).toMatchObject({ mode: 'p25', encrypted: true, algid: 0x84, kid: 0x4321, mbeDecoding: false });
	});
	it('does not report P25 from sync followed by an invalid NID', () => {
		const statuses = [];
		const decoder = new DSDDecoder(() => {}, status => statuses.push(status));
		const received = frame('ldu1');
		for (let i = 24; i < 57; i++) received[i] = (i * 7) & 3;
		for (const d of received.subarray(0, 57)) decoder.feedDibit(d);
		expect(statuses.some(status => status.mode === 'p25')).toBe(false);
	});
	it('requires a clean acquisition NID but retains full correction after lock', () => {
		const damaged = frame('tdu');
		for (const offset of [24, 27, 29, 31, 33, 38, 40, 43, 48, 51, 54]) damaged[offset] ^= 1;
		const statuses = [];
		const decoder = new DSDDecoder(() => {}, status => statuses.push(status));
		for (const d of damaged) decoder.feedDibit(d);
		expect(statuses.some(status => status.mode === 'p25')).toBe(false);
		for (let i = 0; i < 3; i++) for (const d of frame('tdu')) decoder.feedDibit(d);
		for (const d of damaged) decoder.feedDibit(d);
		expect(statuses.at(-1)).toMatchObject({ mode: 'p25', nidErrors: 11, syncCount: 4 });
	});
	it('starts a clear call after an encrypted terminator even if its header was missed', async () => {
		codec.imbe.mockClear();
		const statuses = [];
		const decoder = new DSDDecoder(() => {}, status => statuses.push(status));
		await Promise.resolve(); await Promise.resolve();
		for (const name of ['encryptedHdu', 'encryptedLdu1', 'tdu', 'ldu1']) for (const d of frame(name)) decoder.feedDibit(d);
		expect(codec.imbe).toHaveBeenCalledTimes(9);
		expect(statuses.at(-1)).toMatchObject({ mode: 'p25', encrypted: false, tg: vectors.tg, src: vectors.src });
		expect(statuses.at(-1).algid).toBeUndefined();
	});
	it('acquires with two damaged sync symbols only after the NID validates', () => {
		const statuses = [];
		const decoder = new DSDDecoder(() => {}, status => statuses.push(status));
		const received = frame('tdu');
		received[2] ^= 2; received[17] ^= 2;
		for (const d of received) decoder.feedDibit(d);
		expect(statuses.at(-1)).toMatchObject({ mode: 'p25', nac: vectors.nac, duid: 'TDU', syncCount: 1 });
	});
});
