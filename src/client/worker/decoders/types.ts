export interface ECCTables {
	ecs: Uint32Array;
	bch: Uint32Array;
}

export type Rtl433Message =
	{ type: 'rtl433_event'; freq: number; event: Record<string, unknown> } | { type: 'rtl433_status'; freq?: number; status: Rtl433Status };

export interface Rtl433Protocol {
	id: number;
	name: string;
	disabled: boolean;
}

export interface Rtl433Status {
	state: 'off' | 'loading' | 'receiving' | 'error';
	message: string;
	sampleRate: number;
	samples: number;
	events: number;
	protocols?: Rtl433Protocol[];
}

export interface RtlModule {
	HEAPF32: Float32Array;
	_malloc(bytes: number): number;
	_free(ptr: number): void;
	stringToNewUTF8(text: string): number;
	UTF8ToString(ptr: number): string;
	_rtl433_init(rate: number, frequency: number, protocols: number): number;
	_rtl433_process(ptr: number, count: number): number;
	_rtl433_flush(): number;
	_rtl433_destroy(): void;
	_rtl433_protocol_count(): number;
	_rtl433_protocol_name(id: number): number;
	_rtl433_protocol_disabled(id: number): number;
}

export type RtlFactory = (options: {
	locateFile(path: string): string;
	onDecoded(json: string): void;
	print(): void;
	printErr(): void;
}) => Promise<RtlModule>;

export interface MbelibModule {
	HEAP8: Int8Array;
	HEAPF32: Float32Array;
	_malloc(this: void, size: number): number;
	_free(this: void, ptr: number): void;
	cwrap(name: string, result: 'number', args: ['number', 'number']): (frame: number, audio: number) => number;
	cwrap(name: string, result: null, args: []): () => void;
}

export type MbelibFactory = (options: { locateFile(path: string): string }) => Promise<MbelibModule>;

export interface SidebandState {
	ssbPhase?: number;
	agcGain?: number;
}

export interface RDSMessage {
	ps?: string;
	rt?: string;
	pi?: string;
	pty?: number;
	ptyLabel?: string;
	tp?: boolean;
	ta?: boolean;
}

export interface POCSAGMessage {
	capcode: number;
	func: number;
	type: 'alpha' | 'tone' | 'numeric';
	text: string;
	baud: number;
}
