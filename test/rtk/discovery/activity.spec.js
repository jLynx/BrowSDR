import { describe, expect, it } from 'vitest';
import { RtkActivityAcquisition } from '@/worker/decoders/rtk/discovery/activity';
import { RtkActivityCandidates } from '@/worker/decoders/rtk/discovery/candidates';
import { RtkIqHistory } from '@/worker/decoders/rtk/discovery/history';
import { verifiedObservation } from '@/worker/decoders/rtk/receiver/policy';
import { mockRtk3Packet, mockRtk3Container } from '../../fixtures/rtk/mock-rtk3';

describe('RTK parallel acquisition allocation', () => {
	it.each(['format', 'overrun', 'clear'])('retires stale cursors and unconfirmed votes after history %s', (change) => {
		const processors = [],
			memory = { buffer: new ArrayBuffer(65536) };
		class EmptyDdc {
			constructor() {
				processors.push(this);
			}
			set_if_sample_rate() {}
			set_bandwidth() {}
			reset() {}
			free() {
				this.freed = true;
			}
			process_iq_only_ptr() {
				return 0;
			}
			process_iq_only_f32_ptr() {
				return 0;
			}
			get_iq_output_len() {
				return 0;
			}
		}
		const pool = new RtkActivityAcquisition(EmptyDdc, memory, { rtk: true }, 2000000, 921.5, () => {}),
			queue = new RtkActivityCandidates(),
			history = new RtkIqHistory(memory, 0.001);
		const radio = (sequence) =>
			verifiedObservation({
				profile: 'rtk3',
				time: sequence,
				frequencyHz: 921401000,
				packet: mockRtk3Packet(mockRtk3Container(undefined, sequence), 4242, 100),
			});
		queue.offer([921.401, 921.791], 0, 915, 928, 919);
		history.append(0, 128, false, 2000000);
		pool.process(0, 128, false, 0, queue, history, []);
		pool.catalogs[0].observe(radio(1));
		const initial = [...processors];
		if (change === 'clear') history.clear();
		const values = change === 'overrun' ? 8192 : 128,
			floats = change === 'format';
		history.append(0, values, floats, 2000000);
		pool.process(0, values, floats, 0.01, queue, history, []);
		expect(initial.every((processor) => processor.freed)).toBe(true);
		expect(pool.frequencies).toEqual([921.791]);
		pool.catalogs[0].observe(radio(2));
		expect(pool.catalogs[0].snapshot()).toEqual([]);
		pool.catalogs[0].observe(radio(3));
		expect(pool.catalogs[0].snapshot()).toHaveLength(1);
		pool.discontinuity();
		expect(pool.catalogs[0].snapshot()).toHaveLength(1);
		pool.free();
	});
	it.each([
		[2000000, 2],
		[20000000, 1],
		[61440000, 1],
	])('bounds %s SPS probes, staggers startup and releases filters exactly once', (rate, lanes) => {
		const processors = [],
			memory = { buffer: new ArrayBuffer(256) };
		class EmptyDdc {
			freed = false;
			constructor() {
				processors.push(this);
			}
			set_if_sample_rate() {}
			set_bandwidth() {}
			reset() {}
			process_iq_only_ptr() {
				return 0;
			}
			get_iq_output_len() {
				return 0;
			}
			free() {
				expect(this.freed).toBe(false);
				this.freed = true;
			}
		}
		const pool = new RtkActivityAcquisition(EmptyDdc, memory, { rtk: true, rtkScanStart: 915, rtkScanEnd: 928 }, rate, 921.5, () => {}),
			queue = new RtkActivityCandidates(),
			history = new RtkIqHistory(memory);
		queue.offer([921.118, 921.401, 921.791, 921.9], 0, 915, 928, 919);
		const process = (time) => {
			history.append(0, 128, false, rate);
			pool.process(0, 128, false, time, queue, history, [921.118]);
		};
		process(0);
		expect(pool.frequencies).toEqual([921.401]);
		process(0.02);
		expect(pool.frequencies).toHaveLength(1);
		process(0.06);
		expect(pool.frequencies).toHaveLength(lanes);
		process(0.1);
		expect(pool.frequencies).toHaveLength(lanes);
		process(0.8);
		expect(pool.frequencies[0]).not.toBe(921.401);
		pool.discontinuity();
		expect(pool.frequencies).toEqual([]);
		expect(processors.every((processor) => processor.freed)).toBe(true);
		pool.free();
		expect(processors.every((processor) => processor.freed)).toBe(true);
	});
});
