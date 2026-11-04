import type { IiodPipe } from './iiod';

/** One channel from an IIO context description, as listed by `iiod PRINT`. */
export interface IioChannel {
	id: string;
	name?: string;
	output: boolean;
	/** Buffer scan index, or null for channels that cannot be streamed. */
	scanIndex: number | null;
	/** Scan element format such as `le:S12/16>>0`. */
	format?: string;
	attributes: string[];
	/** Bit position in the device buffer mask, numbered as libiio does. */
	maskBit: number;
}

export interface IioDevice {
	id: string;
	name?: string;
	label?: string;
	channels: IioChannel[];
	attributes: string[];
}

export interface IioContext {
	name?: string;
	description?: string;
	attributes: Record<string, string>;
	devices: IioDevice[];
}

/** Sample layout decoded from an IIO scan element format string. */
export interface IioSampleFormat {
	littleEndian: boolean;
	signed: boolean;
	bits: number;
	storageBits: number;
	shift: number;
}

/** One bulk IN/OUT endpoint couple, served by its own iiod parser on the device. */
export interface IiodPipeEndpoints {
	pipeId: number;
	inEndpoint: number;
	outEndpoint: number;
	packetSize: number;
}

export interface IiodUsbInterface {
	interfaceNumber: number;
	pipes: IiodPipeEndpoints[];
}

/** A receive stream on its own pipe; `done` settles once its last READBUF reply is consumed. */
export interface PlutoRxSession {
	pipe: IiodPipe;
	done: Promise<void>;
	error?: Error;
}

/** Attribute address within the remote IIO context. */
export interface IioAttributeTarget {
	device: IioDevice;
	channel?: IioChannel;
	attribute: string;
}
