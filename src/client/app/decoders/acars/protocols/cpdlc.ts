// FANS message catalogue/PER layouts adapted from MIT xoolive/datalink.
import catalog from './cpdlc-catalog.json';
import { Bits } from './bits';
import * as values from './cpdlc-values';
import { positionReport } from './cpdlc-reports';
import type { ApplicationDecode, CpdlcElement, CpdlcEntry } from './types';
import type { AcarsField } from '@/app/decoders/acars/types';

const readers: Record<string, (bits: Bits) => string> = {
	altitude: values.altitude,
	time: values.time,
	speed: values.speed,
	position: values.position,
	direction: values.direction,
	degrees: values.degrees,
	distanceoffset: values.distance,
	beaconcode: values.beacon,
	frequency: values.frequency,
	icaounitname: values.unit,
	procedurename: values.procedure,
	altimeter: values.altimeter,
	freetext: (bits) => bits.text(bits.read(8) + 1),
	atiscode: (bits) => bits.text(1, true),
	icaofacilitydesignation: (bits) => bits.text(4, true),
	versionnumber: (bits) => String(bits.read(4)),
	positionreport: positionReport,
	tp4table: (bits) => (bits.read(1) ? 'Label B' : 'Label A'),
};
// These bodies consist solely of supported parameters in the catalogue's order.
const supportedBodies: Record<'uplink' | 'downlink', Set<number>> = {
	uplink: new Set([
		6, 7, 8, 9, 10, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42,
		43, 44, 45, 46, 47, 48, 49, 51, 52, 53, 54, 59, 61, 62, 63, 64, 65, 66, 68, 69, 71, 74, 75, 77, 78, 81, 82, 88, 90, 92, 93, 98, 100,
		104, 105, 106, 108, 109, 111, 112, 115, 117, 118, 119, 120, 121, 123, 128, 129, 130, 148, 149, 150, 151, 152, 153, 155, 157, 160, 163,
		169, 170, 175, 180,
	]),
	downlink: new Set([
		6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 22, 23, 27, 28, 29, 30, 31, 32, 33, 34, 37, 38, 39, 42, 44, 45, 47, 49, 54, 60, 61, 64, 67,
		48, 68, 71, 72, 73, 76, 77, 79, 80,
	]),
};

function element(bits: Bits, direction: 'uplink' | 'downlink'): CpdlcElement {
	const id = bits.read(8);
	const entry: CpdlcEntry | undefined = catalog[direction].find((item) => item.id === id);
	if (!entry || /reserved/i.test(entry.template)) throw new Error('Unknown CPDLC element');
	const slots = [...entry.template.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
	if (slots.length && (!supportedBodies[direction].has(id) || slots.some((slot) => !readers[slot]))) {
		return { phrase: `${entry.template} · parameters undecoded (${entry.name})`, complete: false };
	}
	const parameters = slots.map((slot) => readers[slot](bits));
	let index = 0;
	return { phrase: entry.template.replace(/\[[^\]]+\]/g, () => parameters[index++]), complete: true };
}

function header(bits: Bits): AcarsField[] {
	const reference = bits.read(1);
	const timestamp = bits.read(1);
	const fields = [{ label: 'CPDLC message ID', value: String(bits.read(6)) }];
	if (reference) fields.push({ label: 'CPDLC referenced message', value: String(bits.read(6)) });
	if (timestamp) {
		const hour = bits.constrained(5, 0, 23);
		const minute = bits.constrained(6, 0, 59);
		const second = bits.constrained(6, 0, 59);
		fields.push({ label: 'CPDLC time', value: `${[hour, minute, second].map((part) => String(part).padStart(2, '0')).join(':')} UTC` });
	}
	return fields;
}

export function decodeCpdlc(bytes: Uint8Array, direction: 'uplink' | 'downlink'): ApplicationDecode {
	const bits = new Bits(bytes);
	const additional = bits.read(1);
	const fields = header(bits);
	const first = element(bits, direction);
	const phrases = [first.phrase];
	let complete = first.complete;
	if (additional && complete) {
		const count = bits.read(2) + 1;
		for (let i = 0; i < count && complete; i++) {
			try {
				const next = element(bits, direction);
				phrases.push(next.phrase);
				complete = next.complete;
			} catch {
				complete = false;
			}
		}
	}
	complete &&= bits.paddingOnly();
	fields.push(...phrases.map((phrase, index) => ({ label: `CPDLC instruction ${index + 1}`, value: phrase })));
	return {
		fields,
		summary: phrases.join(' · '),
		complete,
		notes: complete ? [] : ['Some CPDLC parameters or trailing elements remain undecoded. The full binary payload is retained.'],
	};
}
