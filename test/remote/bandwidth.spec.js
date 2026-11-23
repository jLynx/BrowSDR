import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebRTCHandler } from '@/remote/webrtc';
import { ReceiverTransport } from '@/remote/receiver-transport';

const monitors = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	for (const monitor of monitors.splice(0)) monitor.close();
	vi.useRealTimers();
});
function peer() {
	let counter = { id: 'transport', type: 'transport', timestamp: 1000, bytesSent: 10000000, bytesReceived: 20000000 };
	return {
		getStats: vi.fn(
			async () =>
				new Map([
					[counter.id, { ...counter }],
					['pair', { type: 'candidate-pair', bytesSent: 1e12 }],
				]),
		),
		set: (time, sent, received, id = 'transport') =>
			(counter = { ...counter, timestamp: time, bytesSent: sent, bytesReceived: received, id }),
	};
}
const connection = (pc) => ({ open: true, peerConnection: pc });
const streams = (pc) => ({ cmd: connection(pc), fft: connection(pc), audio: connection(pc) });
function monitor(host = true) {
	const transport = new WebRTCHandler(host);
	monitors.push(transport.bandwidth);
	const values = [];
	const unsubscribe = transport.bandwidth.subscribe((snapshot) => values.push(snapshot));
	return { transport, values, unsubscribe };
}

describe('live remote bandwidth', () => {
	it('sums every client/channel once and uses elapsed transport time instead of lifetime bytes', async () => {
		const { transport, values } = monitor();
		const audio = peer(),
			fft = peer(),
			bob = peer();
		transport.clients.set('alice', { cmd: connection(audio), audio: connection(audio), fft: connection(fft) });
		transport.clients.set('bob', streams(bob));
		await vi.advanceTimersByTimeAsync(1000);
		expect(audio.getStats).toHaveBeenCalledOnce();
		expect(values.at(-1)).toMatchObject({ ready: false, peers: 2, uploadBps: 0 });
		audio.set(3000, 11000000, 20002000);
		fft.set(3000, 10050000, 20000000);
		bob.set(3000, 10500000, 20003000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(values.at(-1)).toMatchObject({ uploadBps: 775000, downloadBps: 2500, peers: 2, ready: true, unavailable: false });
	});

	it('measures received traffic on clients in both audio and IQ modes', async () => {
		const { transport, values } = monitor(false);
		const pc = peer();
		Object.assign(transport, { connCmd: connection(pc), connFft: connection(pc), connAudio: connection(pc) });
		await vi.advanceTimersByTimeAsync(1000);
		pc.set(2000, 10001000, 20500000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(values.at(-1)).toMatchObject({ downloadBps: 500000, uploadBps: 1000, peers: 1, ready: true });
	});

	it('waits for a new client baseline before displaying an aggregate total', async () => {
		const { transport, values } = monitor(),
			alice = peer(),
			bob = peer();
		transport.clients.set('alice', streams(alice));
		await vi.advanceTimersByTimeAsync(1000);
		alice.set(2000, 10100000, 20000000);
		transport.clients.set('bob', streams(bob));
		await vi.advanceTimersByTimeAsync(1000);
		expect(values.at(-1)).toMatchObject({ peers: 2, ready: false });
		alice.set(3000, 10200000, 20000000);
		bob.set(2000, 10100000, 20000000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(values.at(-1)).toMatchObject({ peers: 2, ready: true, uploadBps: 200000 });
	});

	it('shares one polling loop across receivers and stops after the last subscriber leaves', async () => {
		const transport = new WebRTCHandler(true),
			pc = peer();
		monitors.push(transport.bandwidth);
		transport.clients.set('alice', streams(pc));
		const lime = new ReceiverTransport('lime', transport, vi.fn());
		const hackrf = new ReceiverTransport('hackrf', transport, vi.fn());
		expect(lime.bandwidth).toBe(hackrf.bandwidth);
		const leaveLime = lime.bandwidth.subscribe(vi.fn());
		const leaveHackrf = hackrf.bandwidth.subscribe(vi.fn());
		await vi.advanceTimersByTimeAsync(0);
		expect(pc.getStats).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(1);
		leaveLime();
		await vi.advanceTimersByTimeAsync(1000);
		expect(pc.getStats).toHaveBeenCalledTimes(2);
		leaveHackrf();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('rebases reset/new counters and clears disconnected peers instead of showing spikes or stale traffic', async () => {
		const { transport, values } = monitor(),
			pc = peer();
		transport.clients.set('alice', streams(pc));
		await vi.advanceTimersByTimeAsync(1000);
		pc.set(2000, 100, 200);
		await vi.advanceTimersByTimeAsync(1000);
		expect(values.at(-1).uploadBps).toBe(0);
		pc.set(3000, 1e9, 1e9, 'new-transport');
		await vi.advanceTimersByTimeAsync(1000);
		expect(values.at(-1).uploadBps).toBe(0);
		pc.set(4000, 1e9 + 50000, 1e9, 'new-transport');
		await vi.advanceTimersByTimeAsync(1000);
		expect(values.at(-1).uploadBps).toBe(50000);
		transport.clients.clear();
		await vi.advanceTimersByTimeAsync(1000);
		expect(values.at(-1)).toMatchObject({ uploadBps: 0, downloadBps: 0, peers: 0, ready: true });
		transport.clients.set('alice', streams(pc));
		pc.set(6000, 2e9, 2e9, 'new-transport');
		await vi.advanceTimersByTimeAsync(1000);
		expect(values.at(-1).uploadBps).toBe(0);
	});

	it('marks incomplete measurements unavailable rather than claiming a partial host total', async () => {
		const { transport, values } = monitor(),
			pc = peer();
		transport.clients.set('alice', streams(pc));
		transport.clients.set('bob', streams({ getStats: vi.fn().mockRejectedValue(new Error('closed')) }));
		await vi.advanceTimersByTimeAsync(1000);
		expect(values.at(-1).unavailable).toBe(true);
		transport.clients.delete('bob');
		pc.set(2000, 10100000, 20000000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(values.at(-1)).toMatchObject({ unavailable: false, ready: true, uploadBps: 100000 });
	});

	it('does not overlap requests or publish an in-flight result after transport shutdown', async () => {
		let complete;
		const pc = { getStats: vi.fn(() => new Promise((resolve) => (complete = resolve))) };
		const transport = new WebRTCHandler(true);
		transport.clients.set('alice', streams(pc));
		monitors.push(transport.bandwidth);
		const values = [];
		transport.bandwidth.subscribe((value) => values.push(value));
		await vi.advanceTimersByTimeAsync(3000);
		expect(pc.getStats).toHaveBeenCalledOnce();
		transport.bandwidth.close();
		const count = values.length;
		complete(new Map());
		await vi.advanceTimersByTimeAsync(0);
		expect(values).toHaveLength(count);
		expect(values.at(-1)).toMatchObject({ peers: 0, uploadBps: 0, ready: true });
		expect(vi.getTimerCount()).toBe(0);
	});
});
