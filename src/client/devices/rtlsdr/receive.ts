import { errorMessage } from '@/platform/errors';
import { receiveTransferSize } from '@/radio/receive-transfer';
import { TRANSFER_BUFFER_SIZE } from './protocol';
import type { RtlCom } from './usb';

/** Keep USB reads queued through brief worker stalls, delivering IQ in submission order. */
export async function receiveRtlIq(
	com: RtlCom,
	sampleRate: number,
	conjugate: boolean,
	active: () => boolean,
	callback: (data: ArrayBufferView) => void,
): Promise<void> {
	const transferSize = receiveTransferSize(sampleRate, TRANSFER_BUFFER_SIZE, 2);
	// Small reads preserve display cadence; enough pending reads cover 256ms of
	// recorder/DSP/GC pauses instead of exhausting four 8ms reads and the device FIFO.
	const depth = Math.max(4, Math.min(64, Math.ceil((sampleRate * 2 * 0.256) / transferSize)));
	// Handle rejections immediately, including reads behind the one being consumed.
	const read = (): Promise<ArrayBuffer | Error> => com.readBulk(transferSize).catch((error: unknown) => new Error(errorMessage(error)));
	const pending = Array.from({ length: depth }, read);
	try {
		while (active()) {
			const result = await pending.shift()!;
			if (!active()) break;
			if (result instanceof Error) throw result;
			if (!result.byteLength || result.byteLength % 2) throw new Error('RTL-SDR bulk read did not contain complete IQ pairs');
			// Replenish USB before conversion, disk capture and downstream DSP dispatch.
			pending.push(read());
			const unsigned = new Uint8Array(result);
			const signed = new Int8Array(unsigned.length);
			for (let i = 0; i < unsigned.length; i++) {
				signed[i] = conjugate && i % 2 ? 128 - unsigned[i] : unsigned[i] - 128;
			}
			callback(new Uint8Array(signed.buffer));
		}
	} catch (error: unknown) {
		if (active()) console.error('RTL-SDR: transfer error:', errorMessage(error));
	} finally {
		await Promise.allSettled(pending);
	}
}
