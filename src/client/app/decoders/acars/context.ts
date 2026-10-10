import { createDecoder } from '@jlynx_/acars-decoder';
import { airportName } from '@jlynx_/acars-decoder/airports';
import type { AcarsRecord } from '@/worker/decoders/acars/types';

const decoder = createDecoder({ airportLookup: airportName });

/** Keep the receiver's display retention; the generic library has no viewer limit. */
export function interpretAcarsLog(records: readonly AcarsRecord[]) {
	const retained = [...records].sort((a, b) => a.receivedAt - b.receivedAt || a.id - b.id).slice(-200);
	return decoder.decodeLog(retained);
}
