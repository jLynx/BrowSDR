/** libairspyhf USB format: signed little-endian int16 Q then I; BrowSDR uses I then Q. */
export function decodeHfIq(data: DataView, bits: 8 | 12 | 16): Int8Array | Int16Array {
	if (data.byteLength % 4) throw new Error('Airspy HF+: incomplete IQ pair');
	const IqArray = bits === 8 ? Int8Array : Int16Array;
	const iq = new IqArray(data.byteLength / 2);
	const shift = bits === 8 ? 8 : bits === 12 ? 4 : 0;
	const align = bits === 12 ? 4 : 0;
	for (let offset = 0, i = 0; offset < data.byteLength; offset += 4, i += 2) {
		iq[i] = (data.getInt16(offset + 2, true) >> shift) << align;
		iq[i + 1] = (data.getInt16(offset, true) >> shift) << align;
	}
	return iq;
}
