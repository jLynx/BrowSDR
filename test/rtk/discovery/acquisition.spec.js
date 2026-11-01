import { describe, expect, it } from 'vitest';
import { RtkStream } from '@/worker/decoders/rtk/stream';
import { mockRtkIq } from '../../fixtures/rtk/mock-iq';
import { mockRadioPayload } from '../../fixtures/rtk/mock-packet';

// The first channel uses real synthesized IQ directly. Later off-centre visits
// use an empty DDC stub because these tests exercise acquisition and visit timing.
class EmptyDdc {
	set_if_sample_rate() {}
	set_bandwidth() {}
	reset() {}
	free() {}
	process_iq_only_ptr() {
		return 0;
	}
	get_iq_output_len() {
		return 0;
	}
}

function survey(start = 919, end = start + 0.05) {
	const memory = { buffer: new ArrayBuffer(65536) },
		messages = [],
		stream = new RtkStream(EmptyDdc, memory, (message) => messages.push(message));
	stream.configure({ rtk: true, freq: 100, rtkProfile: 'scan', rtkScanStart: start, rtkScanEnd: end }, 1000000, start);
	let chunk = 0;
	const feed = (iq) => {
		for (let at = 0; at < iq.length; at += 8190) {
			const part = iq.subarray(at, at + 8190);
			new Uint8Array(memory.buffer).set(part);
			stream.process(0, part.length, false, ++chunk);
		}
	};
	const silence = (seconds) => feed(new Uint8Array(Math.round(seconds * 2000000)));
	const snapshot = () => {
		stream.emit();
		return messages.at(-1);
	};
	return { stream, feed, silence, snapshot, gap: () => chunk++ };
}

describe('RTK discovery burst acquisition', () => {
	it('checks an activity candidate immediately alongside the sweep without resetting inventory', () => {
		const test = survey(919, 919.2);
		test.feed(mockRtkIq());
		test.feed(mockRtkIq());
		test.stream.offerCandidates([919.173, 929, NaN], 1000000, 919);
		expect(test.snapshot().stations).toHaveLength(1);
		test.silence(0.06);
		expect(test.snapshot().status.scan).toMatchObject({ frequencyMHz: 919, activityFrequenciesMHz: [919.173] });
		test.silence(0.8);
		expect(test.snapshot().status.scan.activityFrequenciesMHz).toEqual([]);
		test.silence(6.5);
		expect(test.snapshot().status.scan).toMatchObject({ frequencyMHz: 919.05, activityCandidate: false });
		expect(test.snapshot().stations).toHaveLength(1);
		test.stream.reset();
	});
	it('ignores hints from a different receive band', () => {
		const test = survey(919, 919.2);
		test.stream.offerCandidates([919.173], 2000000, 919);
		test.stream.offerCandidates([919.173], 1000000, 919.1);
		test.silence(1.4);
		expect(test.snapshot().status.scan).toMatchObject({ frequencyMHz: 919.05, activityCandidate: false });
		test.stream.reset();
	});
	it.each([919, 923.118])('confirms a base on %s MHz when its second burst arrives after the short scan visit', (frequency) => {
		const test = survey(frequency);
		test.silence(1.1);
		test.feed(mockRtkIq());
		expect(test.snapshot().stations).toEqual([]);
		expect(test.snapshot().status.packets).toBe(1);
		test.silence(2);
		expect(test.snapshot().status.scan.channel).toBe(1);
		test.feed(mockRtkIq());
		expect(test.snapshot().stations).toHaveLength(1);
		expect(test.snapshot().stations[0].reference).toBeDefined();
		test.stream.reset();
	});
	it('keeps short visits for empty channels and packets that fail their radio checksum', () => {
		const test = survey(),
			invalid = mockRtkIq();
		invalid.fill(0, 150000, 155000);
		test.silence(1.1);
		test.feed(invalid);
		test.silence(0.2);
		expect(test.snapshot().status.packets).toBe(0);
		expect(test.snapshot().status.scan.channel).toBe(2);
		test.silence(1.4);
		expect(test.snapshot().status.scan.pass).toBe(2);
		test.stream.reset();
	});
	it('allows confirmation after a first burst near the end of a known fixed-channel visit', () => {
		const test = survey(923.118);
		test.silence(5.8);
		test.feed(mockRtkIq());
		test.silence(2);
		test.feed(mockRtkIq());
		expect(test.snapshot().stations).toHaveLength(1);
		test.stream.reset();
	});
	it('bounds the extended visit even when more unconfirmed overlapping bases appear', () => {
		const test = survey();
		test.silence(1.1);
		test.feed(mockRtkIq());
		test.silence(4.6);
		test.feed(mockRtkIq(mockRadioPayload({ scan: 1235, channel: 7, netId: 42 })));
		expect(test.snapshot().status.packets).toBe(2);
		expect(test.snapshot().stations).toEqual([]);
		test.silence(1.9);
		expect(test.snapshot().status.scan.channel).toBe(2);
		test.stream.reset();
	});
	it('does not confirm a source across an IQ gap', () => {
		const test = survey();
		test.silence(1.1);
		test.feed(mockRtkIq());
		test.gap();
		test.silence(2);
		test.feed(mockRtkIq());
		expect(test.snapshot().status.packets).toBe(2);
		expect(test.snapshot().stations).toEqual([]);
		expect(test.snapshot().status.discontinuities).toBe(1);
		test.stream.reset();
	});
	it('retains verified identity evidence when a corrupt header occurs between two good bursts', () => {
		const test = survey(),
			invalid = mockRtkIq();
		const headerStart = 2 * Math.ceil((1024 + 36.25 * 256) * 1.00002);
		invalid.fill(0, headerStart, headerStart + 2 * 8 * 256);
		test.feed(mockRtkIq());
		test.silence(0.1);
		test.feed(invalid);
		test.silence(0.1);
		test.feed(mockRtkIq());
		expect(test.snapshot().status.packets).toBe(2);
		expect(test.snapshot().stations).toHaveLength(1);
		test.stream.reset();
	});
});
