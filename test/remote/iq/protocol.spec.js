import { describe, expect, it } from 'vitest';
import { packIqPacket, unpackIqPacket, MAX_IQ_VALUES } from '@/remote/iq/packet';
import { needsSlice, planIqSlice } from '@/remote/iq/plan';
import { packReceiverChunk, unpackReceiverChunk } from '@/remote/receiver-transport';
import { isReceiverCommand } from '@/remote/validation';

const vfo = { freq: 106.2, mode: 'wfm', bandwidth: 150000, enabled: true };
const packet = {
	index: 2,
	revision: 9,
	sequence: 42,
	bits: 16,
	scale: 0.002,
	samples: new Int16Array([-32767, 1234, 42, 32767]),
	centerFreq: 106.2,
	sampleRate: 250000,
	bandwidth: 150000,
	fullBand: false,
	discontinuity: true,
};

describe('remote IQ protocol', () => {
	it.each([8, 16])('preserves signed %s-bit IQ through receiver envelopes', (bits) => {
		const samples = bits === 8 ? new Int8Array([-127, 127, 0, -42]) : packet.samples;
		const wrapped = packReceiverChunk('lime-📻', packIqPacket({ ...packet, samples, bits }));
		const received = unpackReceiverChunk(wrapped);
		expect(received.receiverId).toBe('lime-📻');
		expect(unpackIqPacket(received.payload)).toMatchObject({ ...packet, bits, samples, scale: expect.closeTo(packet.scale, 7) });
	});
	it.each([
		[4, 2],
		[5, 12],
		[6, 4],
		[20, 3],
		[20, MAX_IQ_VALUES + 2],
		[32, NaN],
		[32, 0],
		[40, -1],
		[44, 300000],
	])('rejects malformed field at byte %s with value %s', (offset, value) => {
		const buffer = packIqPacket(packet);
		const view = new DataView(buffer);
		if (offset < 7) view.setUint8(offset, value);
		else if (offset === 20) view.setUint32(offset, value, true);
		else if (offset === 32) view.setFloat64(offset, value, true);
		else view.setFloat32(offset, value, true);
		expect(unpackIqPacket(buffer)).toBeNull();
	});
	it('rejects truncation and trailing payload and validates negotiation and revisions', () => {
		const buffer = packIqPacket(packet);
		expect(unpackIqPacket(buffer.slice(0, -1))).toBeNull();
		expect(unpackIqPacket(new Uint8Array([...new Uint8Array(buffer), 0]).buffer)).toBeNull();
		expect(isReceiverCommand({ type: 'streamCapabilities', iqSlices: true })).toBe(true);
		expect(isReceiverCommand({ type: 'clientStream', stream: 'iq', bits: 8 })).toBe(true);
		expect(isReceiverCommand({ type: 'clientStream', stream: 'iq', bits: 32 })).toBe(false);
		expect(isReceiverCommand({ type: 'vfoUpdate', index: 0, params: vfo, revision: -1 })).toBe(false);
	});
});

describe('decoder-aware RF slices', () => {
	it('uses a 250 kSPS slice for ordinary WFM on a 20 MSPS source', () => {
		expect(planIqSlice(vfo, 20e6, 100)).toEqual({ centerFreq: 106.2, sampleRate: 250000, bandwidth: 150000, fullBand: false });
		expect(planIqSlice({ ...vfo, stereo: true }, 20e6, 100).bandwidth).toBe(200000);
		expect(planIqSlice({ ...vfo, rds: true }, 20e6, 100).bandwidth).toBe(250000);
	});
	it.each([
		['nfm', {}, 2000, 50000],
		['am', {}, 2000, 15000],
		['usb', {}, 4000, 24000],
		['lsb', {}, 4000, 24000],
		['dsb', {}, 2000, 24000],
		['cw', {}, 2000, 3000],
		['dsd', {}, 2000, 48000],
		['raw', {}, 2000, 48000],
		['nfm', { pocsag: true }, 15000, 50000],
		['nfm', { gsc: true }, 12500, 50000],
		['nfm', { flex: true }, 18000, 50000],
		['wfm', { rds: true }, 250000, 250000],
		['hdradio', {}, 400000, 744187.5],
		['nfm', { rtl433: true, rtl433SampleRate: 250000 }, 200000, 250000],
		['nfm', { adsb: true }, 2000000, 2000000],
		['nfm', { ble: true }, 2000000, 2000000],
		['nfm', { ais: true }, 25000, 48000],
		['nfm', { radiosonde: true }, 20000, 48000],
		['am', { acars: true }, 25000, 48000],
		['nfm', { aprs: true }, 16000, 48000],
		['nfm', { rtk: true, rtkProfile: 'rtk2' }, 1000000, 1000000],
	])('preserves %s decoder %j with a narrowed audio filter', (mode, decoders, bandwidth, rate) => {
		const params = { ...vfo, mode, bandwidth: 2000, ...decoders };
		const slice = planIqSlice(params, 20e6, 100);
		expect(slice.bandwidth).toBeGreaterThanOrEqual(bandwidth);
		expect(slice.sampleRate).toBeGreaterThanOrEqual(rate);
	});
	it.each([{ rtkProfile: 'auto' }, { rtkProfile: 'scan' }, { rtkProfile: 'rtk1', rtkFollowHops: true }])(
		'keeps the capture available for RTK discovery/hopping %j',
		(rtk) => {
			expect(planIqSlice({ ...vfo, rtk: true, ...rtk }, 20e6, 100)).toMatchObject({ sampleRate: 20e6, centerFreq: 100, fullBand: true });
		},
	);
	it('fits complete passbands near capture edges and rejects unavailable RF', () => {
		expect(planIqSlice({ ...vfo, freq: 109.9 }, 20e6, 100)).toMatchObject({
			centerFreq: 109.875,
			sampleRate: 250000,
			bandwidth: expect.closeTo(200000, 5),
		});
		for (const freq of [110, 111]) expect(planIqSlice({ ...vfo, freq }, 20e6, 100)).toBeNull();
		expect(planIqSlice({ ...vfo, mode: 'nfm', bandwidth: 2000, radiosonde: true, freq: 109.99 }, 20e6, 100)).toBeNull();
		expect(planIqSlice({ ...vfo, hdradio: true, mode: 'hdradio' }, 250000, 106.2)).toBeNull();
		expect(planIqSlice(vfo, 20e6, NaN)).toBeNull();
		expect(needsSlice({ ...vfo, enabled: false })).toBe(false);
		expect(needsSlice({ ...vfo, enabled: false, radiosonde: true })).toBe(true);
	});
});
