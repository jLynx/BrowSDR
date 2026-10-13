// RS41 uses two interleaved RS(255,231) words, GF(256), primitive
// polynomial 0x11d, with generator roots alpha^0 through alpha^23.
const exp = new Uint8Array(510);
const log = new Uint8Array(256);
let value = 1;
for (let index = 0; index < 255; index++) {
	exp[index] = exp[index + 255] = value;
	log[value] = index;
	value <<= 1;
	if (value & 256) value ^= 0x11d;
}
const multiply = (a: number, b: number): number => (a && b ? exp[log[a] + log[b]] : 0);
const divide = (a: number, b: number): number => (a ? exp[(log[a] - log[b] + 255) % 255] : 0);

function evaluate(poly: Uint8Array, x: number): number {
	let result = 0;
	for (let index = poly.length - 1; index >= 0; index--) result = multiply(result, x) ^ poly[index];
	return result;
}

function syndromes(word: Uint8Array): Uint8Array {
	return Uint8Array.from({ length: 24 }, (_, index) => evaluate(word, exp[index]));
}

// Berlekamp-Massey: coefficients are in ascending polynomial order.
function locator(s: Uint8Array): Uint8Array | undefined {
	const current = new Uint8Array(25);
	let previous = new Uint8Array(25);
	current[0] = previous[0] = 1;
	let degree = 0;
	let shift = 1;
	let last = 1;
	for (let index = 0; index < s.length; index++) {
		let discrepancy = s[index];
		for (let term = 1; term <= degree; term++) discrepancy ^= multiply(current[term], s[index - term]);
		if (!discrepancy) {
			shift++;
			continue;
		}
		const saved = current.slice();
		const factor = divide(discrepancy, last);
		for (let term = shift; term < current.length; term++) current[term] ^= multiply(factor, previous[term - shift]);
		if (2 * degree <= index) {
			degree = index + 1 - degree;
			previous = saved;
			last = discrepancy;
			shift = 1;
		} else shift++;
	}
	if (!degree || degree > 12) return undefined;
	return current.slice(0, degree + 1);
}

function magnitudes(positions: number[], s: Uint8Array): Uint8Array | undefined {
	const count = positions.length;
	const rows = positions.map((_, row) => {
		const values = new Uint8Array(count + 1);
		for (let column = 0; column < count; column++) values[column] = exp[(row * positions[column]) % 255];
		values[count] = s[row];
		return values;
	});
	for (let column = 0; column < count; column++) {
		const pivot = rows.findIndex((row, index) => index >= column && row[column] !== 0);
		if (pivot < 0) return undefined;
		[rows[column], rows[pivot]] = [rows[pivot], rows[column]];
		const scale = rows[column][column];
		for (let index = column; index <= count; index++) rows[column][index] = divide(rows[column][index], scale);
		for (let row = 0; row < count; row++) {
			if (row === column) continue;
			const factor = rows[row][column];
			for (let index = column; index <= count; index++) rows[row][index] ^= multiply(factor, rows[column][index]);
		}
	}
	return Uint8Array.from(rows, (row) => row[count]);
}

function repairWord(word: Uint8Array): Uint8Array | undefined {
	const s = syndromes(word);
	if (!s.some(Boolean)) return word;
	const polynomial = locator(s);
	if (!polynomial) return undefined;
	const positions: number[] = [];
	for (let position = 0; position < 255; position++) if (evaluate(polynomial, exp[(255 - position) % 255]) === 0) positions.push(position);
	if (positions.length !== polynomial.length - 1) return undefined;
	const errors = magnitudes(positions, s);
	if (!errors) return undefined;
	const corrected = word.slice();
	positions.forEach((position, index) => (corrected[position] ^= errors[index]));
	return syndromes(corrected).some(Boolean) ? undefined : corrected;
}

/** Return a corrected copy only when both words have valid syndromes. */
export function correctRs41(frame: Uint8Array): Uint8Array | undefined {
	if (frame.length !== 320 && frame.length !== 518) return undefined;
	const result = frame.slice();
	for (let parity = 0; parity < 2; parity++) {
		const word = new Uint8Array(255);
		word.set(frame.subarray(8 + parity * 24, 32 + parity * 24));
		for (let index = 56 + parity; index < frame.length; index += 2) word[24 + (index - 56 - parity) / 2] = frame[index];
		const corrected = repairWord(word);
		if (!corrected) return undefined;
		// The shortened word's omitted data must remain zero.
		if (corrected.subarray(24 + (frame.length - 56) / 2).some(Boolean)) return undefined;
		result.set(corrected.subarray(0, 24), 8 + parity * 24);
		for (let index = 56 + parity; index < frame.length; index += 2) result[index] = corrected[24 + (index - 56 - parity) / 2];
	}
	return result;
}
