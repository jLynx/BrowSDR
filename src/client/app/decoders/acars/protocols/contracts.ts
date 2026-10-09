// ADS-C contract layouts adapted from xoolive/datalink and checked against libacars.
import type { Bits } from './bits';
import type { AcarsField } from '@/app/decoders/acars/types';

const groupNames: Record<number, string> = {
	12: 'Flight identification',
	13: 'Predicted route',
	14: 'Ground track / speed',
	15: 'Heading / Mach',
	16: 'Weather',
	17: 'Airframe identification',
	21: 'Aircraft intent',
};

export function contractFields(bits: Bits, tag: number): AcarsField[] | undefined {
	if (tag === 1) return [{ label: 'Contract control', value: 'Cancel all contracts' }];
	if (tag === 2 || tag === 6) return [{ label: 'Cancel contract', value: String(bits.read(8)) }];
	if (![7, 8, 9].includes(tag)) return;
	const fields = [
		{ label: tag === 8 ? 'Event contract' : tag === 9 ? 'Emergency periodic contract' : 'Periodic contract', value: String(bits.read(8)) },
	];
	if (tag !== 8) {
		if (bits.read(8) !== 11) throw new Error('Missing reporting interval');
		const code = bits.read(8);
		fields.push({ label: 'Reporting interval', value: `${[0, 1, 8, 64][code >> 6] * ((code & 63) + 1)} seconds` });
	}
	while (bits.remaining >= 8) {
		const position = bits.position;
		const group = bits.read(8);
		const field = tag === 8 ? eventField(bits, group) : groupField(bits, group);
		if (!field) {
			bits.position = position;
			break;
		}
		fields.push(field);
	}
	return fields;
}

function groupField(bits: Bits, group: number): AcarsField | undefined {
	if (!groupNames[group]) return;
	const modulus = bits.read(8);
	return {
		label: `Requested ${groupNames[group]}`,
		value: `Reporting modulus ${modulus}${group === 21 ? ` · projection ${bits.read(8)} minutes` : ''}`,
	};
}

function eventField(bits: Bits, tag: number): AcarsField | undefined {
	if (tag === 10) return { label: 'Lateral deviation threshold', value: `${bits.read(8) / 8} NM` };
	if (tag === 18) return { label: 'Vertical speed threshold', value: `${bits.signed(8) * 64} ft/min` };
	if (tag === 19) return { label: 'Altitude range', value: `Ceiling ${bits.signed(16) * 4} ft · floor ${bits.signed(16) * 4} ft` };
	if (tag === 20) return { label: 'Event trigger', value: 'Waypoint change' };
}
