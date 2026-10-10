// ADS-C tag layouts/scales: MIT libacars and xoolive/datalink (see public/licenses/acars.txt).
import { Bits } from './bits';
import { contractFields } from './contracts';
import type { AcarsField } from '@/app/decoders/acars/types';
import type { ApplicationDecode } from './types';

const basicNames: Record<number, string> = {
	7: 'Position report',
	9: 'Emergency position report',
	10: 'Lateral deviation event',
	18: 'Vertical rate event',
	19: 'Altitude range event',
	20: 'Waypoint change event',
};
const angle = (value: number, scale: number) => (value * scale + 360) % 360;
const number = (value: number) => String(Number(value.toFixed(6)));

function coordinates(bits: Bits, prefix = ''): AcarsField[] {
	const latitude = (bits.signed(21) * 180) / 2 ** 20;
	const longitude = (bits.signed(21) * 180) / 2 ** 20;
	if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error('Invalid position');
	return [
		{ label: `${prefix}Latitude`, value: `${number(latitude)}°` },
		{ label: `${prefix}Longitude`, value: `${number(longitude)}°` },
		{ label: `${prefix}Altitude`, value: `${bits.signed(16) * 4} ft` },
	];
}

function basic(bits: Bits, tag: number): AcarsField[] {
	const fields = [{ label: 'ADS-C report', value: basicNames[tag] }, ...coordinates(bits)];
	const time = bits.read(15) / 8;
	const status = bits.read(7);
	fields.push(
		{ label: 'Report time', value: `${time} seconds past the hour (date/hour not supplied)` },
		{ label: 'Navigation redundancy', value: status & 1 ? 'Available' : 'Unavailable' },
		{ label: 'Position accuracy code', value: String((status >> 1) & 7) },
		{ label: 'TCAS', value: status & 16 ? 'Available' : 'Unavailable' },
	);
	return fields;
}

function velocity(bits: Bits, tag: number): AcarsField[] {
	const invalid = bits.read(1);
	const heading = angle(bits.signed(12), 180 / 2048);
	const speed = bits.read(13);
	const vertical = bits.signed(12) * 16;
	bits.read(2);
	return [
		{ label: tag === 14 ? 'True track' : 'True heading', value: invalid ? 'Unavailable' : `${number(heading)}°` },
		{ label: tag === 14 ? 'Ground speed' : 'Mach', value: tag === 14 ? `${speed / 2} kt` : String(speed / 2000) },
		{ label: tag === 14 ? 'Ground vertical rate' : 'Air vertical rate', value: `${vertical} ft/min` },
	];
}

function weather(bits: Bits): AcarsField[] {
	const speed = bits.read(9) / 2;
	const invalid = bits.read(1);
	const direction = angle(bits.signed(9), 180 / 256);
	const temperature = bits.signed(12) / 4;
	bits.read(1);
	return [
		{ label: 'Wind speed', value: `${speed} kt` },
		{ label: 'True wind direction', value: invalid ? 'Unavailable' : `${number(direction)}°` },
		{ label: 'Temperature', value: `${temperature} °C` },
	];
}

function projection(bits: Bits, tag: number): AcarsField[] {
	if (tag === 13) {
		const fields = [
			...coordinates(bits, 'Next waypoint '),
			{ label: 'Next waypoint ETA', value: `${bits.read(14)} seconds` },
			...coordinates(bits, 'Following waypoint '),
		];
		bits.read(6);
		return fields;
	}
	if (tag === 23) return [...coordinates(bits, 'Projected '), { label: 'Projection time', value: `${bits.read(14)} seconds` }];
	const distance = bits.read(16) / 8;
	const invalid = bits.read(1);
	const track = angle(bits.signed(12), 180 / 2048);
	const altitude = bits.signed(16) * 4;
	const eta = bits.read(14);
	bits.read(5);
	return [
		{ label: 'Projected distance', value: `${distance} NM` },
		{ label: 'Projected track', value: invalid ? 'Unavailable' : `${number(track)}°` },
		{ label: 'Projected altitude', value: `${altitude} ft` },
		{ label: 'Projection time', value: `${eta} seconds` },
	];
}

function noncompliance(bits: Bits): AcarsField[] {
	const contract = bits.read(8);
	const count = bits.read(8);
	const fields = [{ label: 'Noncompliance contract', value: String(contract) }];
	for (let group = 0; group < count; group++) {
		const tag = bits.read(8);
		const unrecognized = bits.read(1);
		const unavailable = bits.read(1);
		bits.read(2);
		const size = bits.read(4);
		const parameters: number[] = [];
		if (!unrecognized && !unavailable) {
			for (let i = 0; i < size; i++) parameters.push(bits.read(4));
			if (size % 2) bits.read(4);
		}
		fields.push({
			label: `Noncompliant group ${tag}`,
			value: unrecognized ? 'Unrecognized' : unavailable ? 'Unavailable' : `Parameter codes: ${parameters.join(', ')}`,
		});
	}
	return fields;
}

function downlinkFields(bits: Bits, tag: number): AcarsField[] | undefined {
	if (basicNames[tag]) return basic(bits, tag);
	if (tag === 14 || tag === 15) return velocity(bits, tag);
	if (tag === 16) return weather(bits);
	if ([13, 22, 23].includes(tag)) return projection(bits, tag);
	if (tag === 5) return noncompliance(bits);
	if (tag === 6) return [{ label: 'Emergency mode', value: 'Cancelled' }];
	if (tag === 3) return [{ label: 'Acknowledged contract', value: String(bits.read(8)) }];
	if (tag === 4) {
		const contract = bits.read(8);
		const reason = bits.read(8);
		return [
			{
				label: 'Rejected contract',
				value: `${contract} · reason code ${reason}${[1, 2, 7].includes(reason) ? ` · extension ${bits.read(8)}` : ''}`,
			},
		];
	}
	if (tag === 17) return [{ label: 'ICAO aircraft address', value: bits.read(24).toString(16).padStart(6, '0').toUpperCase() }];
	if (tag === 12) {
		let flight = '';
		for (let i = 0; i < 8; i++) {
			const code = bits.read(6);
			flight += String.fromCharCode(code & 32 ? code : code + 64);
		}
		return [{ label: 'Reported flight', value: flight.trimEnd() }];
	}
}

export function decodeAdsc(bytes: Uint8Array, direction: 'uplink' | 'downlink'): ApplicationDecode {
	const bits = new Bits(bytes);
	const fields: AcarsField[] = [];
	let unknown: number | undefined;
	while (bits.remaining) {
		const tag = bits.read(8);
		const next = direction === 'uplink' ? contractFields(bits, tag) : downlinkFields(bits, tag);
		if (!next) {
			unknown = tag;
			break;
		}
		fields.push(...next);
		if (fields.length > 200) throw new Error('Too many application fields');
	}
	if (!fields.length) throw new Error('No supported ADS-C tags');
	const position = fields.find((field) => field.label === 'Latitude');
	return {
		fields,
		complete: unknown === undefined,
		summary: position
			? `ADS-C position · ${position.value}, ${fields.find((field) => field.label === 'Longitude')?.value} · ${fields.find((field) => field.label === 'Altitude')?.value}.`
			: `ADS-C ${direction === 'uplink' ? 'contract request' : 'report'} · ${fields[0].value}.`,
		notes:
			unknown === undefined
				? []
				: [`Unsupported ADS-C tag ${unknown}; the remaining application bytes are preserved without guessing their layout.`],
	};
}
