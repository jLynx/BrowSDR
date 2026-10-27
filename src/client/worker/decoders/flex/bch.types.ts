/** Types for the FLEX BCH(31,21,2)+parity FEC module. */

export interface BchResult {
	/** Corrected 21-bit info (bits 0-20), or -1 if uncorrectable. */
	info: number;
	/** BCH_CLEAN | BCH_CORRECTED | BCH_UNCORRECTABLE. */
	status: number;
	/** Corrected full 32-bit word (code31 + recomputed parity); valid when info >= 0. */
	corrected: number;
}
