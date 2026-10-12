export interface PocsagState {
	panelOpen: boolean;
	log: PocsagLogEntry[];
}

export type RdsStations = Record<
	number,
	{ ps: string; rt: string; pi: string; pty: number; ptyLabel: string; tp: boolean; ta: boolean; freq: string }
>;

export interface PocsagLogEntry {
	time: string;
	freq: string;
	vfoIndex: number;
	capcode: string;
	type: string;
	/** Function sub-address 0-3 (shown as A-D). */
	func: number;
	text: string;
	/** Per-character decode status parallel to text: 0 ok, 1 corrected, 2 bad. */
	charStatus: number[];
	baud: number;
	detectDebug?: string;
	/** Runner-up interpretation (second guess), shown dimmed when enabled. */
	alt?: { type: 'alpha' | 'numeric'; text: string };
}

export interface Rtl433LogEntry {
	time: string;
	freq: string;
	vfoIndex: number;
	event: Record<string, unknown>;
}

export interface RdsLogEntry {
	time: string;
	field: string;
	value: string;
	freq: string;
	vfoIndex: number;
}
