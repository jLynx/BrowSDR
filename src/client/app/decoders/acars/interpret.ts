import { createDecoder } from '@jlynx_/acars-decoder';
import { airportName } from '@jlynx_/acars-decoder/airports';

const decoder = createDecoder({ airportLookup: airportName });
export const interpretAcars = decoder.decode;
