/*
Adapted from libairspy v1.0.10 iqconverter_float.c and filters.h:
https://github.com/airspy/airspyone_host/tree/v1.0.10/libairspy/src
Copyright (C) 2014, Youssef Touil <youssef@airspy.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/

// Nonzero even taps of the 47-tap half-band filter, folded by symmetry.
const HALF_BAND = new Float32Array([
	-0.00099860627294751, 0.001695637278417295, -0.003054430179754289, 0.005055504379767936, -0.007901319195893647, 0.011873357051047719,
	-0.017411159379930066, 0.025304817427568772, -0.037225225204559217, 0.057533286997004301, -0.10232746200425935, 0.3170344725089474,
]);

function quantize(value: number): number {
	return Math.max(-128, Math.min(127, Math.round(value * 128)));
}

/** Unpacked unsigned 12-bit real ADC at 2× IQ rate → signed interleaved IQ.
 * Runs in the receive worker. Filter, DC and translation phase span USB reads.
 */
export class AirspyIqConverter {
	private readonly history = new Float32Array(48);
	private readonly delay = new Float32Array(12);
	private readonly tail = new Uint8Array(4);
	private tailLength = 0;
	private average = 0;
	private head = 0;
	private delayHead = 0;
	private sign = -1;

	process(data: DataView): Int8Array {
		const output = new Int8Array(Math.floor((this.tailLength + data.byteLength) / 4) * 2);
		let offset = 0;
		let position = 0;
		if (this.tailLength) {
			while (this.tailLength < 4 && offset < data.byteLength) {
				this.tail[this.tailLength++] = data.getUint8(offset++);
			}
			if (this.tailLength < 4) return output;
			this.convertPair(this.tail[0] | (this.tail[1] << 8), this.tail[2] | (this.tail[3] << 8), output, position);
			position += 2;
			this.tailLength = 0;
		}
		for (; offset + 4 <= data.byteLength; offset += 4, position += 2) {
			this.convertPair(data.getUint16(offset, true), data.getUint16(offset + 2, true), output, position);
		}
		while (offset < data.byteLength) this.tail[this.tailLength++] = data.getUint8(offset++);
		return output;
	}

	private convertPair(first: number, second: number, output: Int8Array, position: number): void {
		// Remove ADC midpoint and residual DC, then translate the Fs/4 IF.
		const even = Math.fround((first - 2048) / 2048 - this.average);
		this.average = Math.fround(this.average + Math.fround(0.01 * even));
		const odd = Math.fround((second - 2048) / 2048 - this.average);
		this.average = Math.fround(this.average + Math.fround(0.01 * odd));
		const head = this.head;
		this.history[head] = this.history[head + 24] = even * this.sign;
		let filtered = 0;
		for (let tap = 0; tap < 12; tap++) {
			filtered += HALF_BAND[tap] * (this.history[head + tap] + this.history[head + 23 - tap]);
		}
		output[position] = quantize(filtered);
		output[position + 1] = quantize(this.delay[this.delayHead]);
		this.delay[this.delayHead] = odd * this.sign * 0.5;
		this.head = head === 0 ? 23 : head - 1;
		this.delayHead = (this.delayHead + 1) % 12;
		this.sign = -this.sign;
	}
}
