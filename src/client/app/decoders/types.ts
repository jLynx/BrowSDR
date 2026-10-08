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
	text: string;
	baud: number;
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
