import { airportDescription } from '@/data/aviation/airports';
import type { AcarsInterpretation } from '@/app/decoders/acars/types';

/** Enrich only explicitly identified airport fields, preserving all raw radio text. */
export function describeAirports(result: AcarsInterpretation): AcarsInterpretation {
	const replacements = new Map<string, string>();
	result.fields = result.fields.map((field) => {
		if (
			!/^(?:Departure|Destination|Alternate Destination|Origin|Airport|Airport code|ATIS Airport|Requested airport \(ICAO\))$/.test(
				field.label,
			)
		)
			return field;
		if (!/^[A-Z]{3,4}$/.test(field.value)) return field;
		const value = airportDescription(field.value);
		if (value !== field.value) replacements.set(field.value, value);
		return { ...field, value };
	});
	if (replacements.size) {
		const pattern = new RegExp(`\\b(?:${[...replacements.keys()].join('|')})\\b`, 'g');
		result.summary = result.summary.replace(pattern, (code) => replacements.get(code)!);
	}
	return result;
}
