import { describeAirports as describe } from '@jlynx_/acars-decoder/formats';
import { airportName } from '@jlynx_/acars-decoder/airports';
import type { AcarsInterpretation } from '@/app/decoders/acars/types';

export function describeAirports(result: AcarsInterpretation): AcarsInterpretation {
	return describe(result, airportName);
}
